/**
 * Installer and remover for the independent sampler. The Host plugin never runs
 * this: `dsh-machine-status install` is an explicit operator command. It writes
 * a stable runtime copy, the user units and the default config, then asks the
 * user systemd manager to enable the timer.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { statePaths } from './paths.mjs'
import { DEFAULT_CONFIG } from './config.mjs'
import { SCHEMA } from './schema.mjs'
import { UNIT_NAMES, serviceUnit, timerUnit } from './units.mjs'
import { ownVersion } from './version.mjs'

/** The directory this package was installed into. */
export function packageRoot() {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)))
}

/**
 * @param {{homeDir?: string}} options
 */
export function runtimePaths(homeDir = os.homedir()) {
  const runtimeDir = path.join(homeDir, '.local', 'lib', 'dsh-machine-status')
  return {
    runtimeDir,
    runtimeScript: path.join(runtimeDir, 'bin', 'sampler.mjs'),
    unitDir: path.join(homeDir, '.config', 'systemd', 'user'),
    serviceFile: path.join(homeDir, '.config', 'systemd', 'user', UNIT_NAMES.service),
    timerFile: path.join(homeDir, '.config', 'systemd', 'user', UNIT_NAMES.timer),
  }
}

function xdgRuntimeDir(env = process.env) {
  if (typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR !== '') return env.XDG_RUNTIME_DIR
  try {
    const candidate = `/run/user/${process.getuid()}`
    return fs.existsSync(candidate) ? candidate : null
  } catch {
    return null
  }
}

/**
 * Run one `systemctl --user` command with a timeout. Injectable for tests.
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, timeoutMs?: number}} options
 */
export function systemctlUser(args, { env = process.env, timeoutMs = 10_000 } = {}) {
  const runtime = xdgRuntimeDir(env)
  const environment = { ...env, ...(runtime === null ? {} : { XDG_RUNTIME_DIR: runtime }) }
  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : (result.error?.message ?? ''),
    error: result.error ?? null,
  }
}

function writeFile(fileSystem, file, text, mode = 0o644) {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fileSystem.writeFileSync(file, text, { mode })
}

/**
 * Install the sampler: config, runtime copy, user units, timer.
 * @param {{
 *   stateDir: string,
 *   packageDir?: string,
 *   homeDir?: string,
 *   execPath?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   fs?: typeof fs,
 *   systemctl?: typeof systemctlUser,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 */
export function installSampler({
  stateDir,
  packageDir = packageRoot(),
  homeDir = os.homedir(),
  execPath = process.execPath,
  dryRun = false,
  force = false,
  fs: fileSystem = fs,
  systemctl = systemctlUser,
  env = process.env,
} = {}) {
  const paths = statePaths(stateDir)
  const runtime = runtimePaths(homeDir)
  const actions = []
  const diagnostics = []

  actions.push(`create state directory ${stateDir} (0700)`)
  actions.push(`runtime copy ${runtime.runtimeDir} from ${packageDir}`)
  actions.push(`config ${paths.config} (${force ? 'rewrite' : 'keep if present'})`)
  actions.push(`write ${runtime.serviceFile}`)
  actions.push(`write ${runtime.timerFile}`)
  actions.push('systemctl --user daemon-reload && enable --now dsh-machine-status.timer && start dsh-machine-status.service')

  if (dryRun) {
    actions.push('dry run: no files or services changed')
    return { ok: true, dryRun: true, actions, diagnostics, stateDir, ...runtime }
  }

  fileSystem.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const configExists = fileSystem.existsSync(paths.config)
  if (!configExists || force) {
    fileSystem.writeFileSync(paths.config, `${JSON.stringify({ ...DEFAULT_CONFIG, ttlMs: 180_000 }, null, 2)}\n`, { mode: 0o600 })
  }

  fileSystem.rmSync(runtime.runtimeDir, { recursive: true, force: true })
  fileSystem.mkdirSync(runtime.runtimeDir, { recursive: true, mode: 0o700 })
  for (const name of ['bin', 'lib']) {
    const source = path.join(packageDir, name)
    if (!fileSystem.existsSync(source)) {
      diagnostics.push(`package is missing ${name}/; cannot install the sampler`)
      continue
    }
    fileSystem.cpSync(source, path.join(runtime.runtimeDir, name), { recursive: true })
  }
  fileSystem.writeFileSync(path.join(runtime.runtimeDir, 'package.json'), `${JSON.stringify({ name: '@sulytwelve/dsh-machine-status', version: ownVersion(), type: 'module' }, null, 2)}\n`, { mode: 0o644 })
  fileSystem.writeFileSync(path.join(runtime.runtimeDir, 'VERSION'), `${ownVersion()}\n`, { mode: 0o644 })
  fileSystem.writeFileSync(path.join(runtime.runtimeDir, 'state.json'), `${JSON.stringify({
    schema: SCHEMA.loaded,
    kind: 'runtime-copy',
    version: ownVersion(),
    installedAt: new Date().toISOString(),
    stateDir,
  }, null, 2)}\n`, { mode: 0o644 })

  writeFile(fileSystem, runtime.serviceFile, serviceUnit({ execPath, scriptPath: runtime.runtimeScript, stateDir }))
  writeFile(fileSystem, runtime.timerFile, timerUnit({ cadenceSec: 60 }))

  const reload = systemctl(['daemon-reload'])
  if (!reload.ok) diagnostics.push(`systemctl --user daemon-reload failed: ${reload.stderr || reload.error?.message || 'unknown error'}`)
  const enable = systemctl(['enable', '--now', UNIT_NAMES.timer])
  if (!enable.ok) diagnostics.push(`systemctl --user enable --now ${UNIT_NAMES.timer} failed: ${enable.stderr || 'unknown error'}`)
  const once = systemctl(['start', UNIT_NAMES.service])
  if (!once.ok) diagnostics.push(`systemctl --user start ${UNIT_NAMES.service} failed: ${once.stderr || 'unknown error'}`)

  return {
    ok: diagnostics.length === 0,
    dryRun: false,
    actions,
    diagnostics,
    stateDir,
    ...runtime,
    version: ownVersion(),
  }
}

/**
 * Remove the units and the runtime copy. The state directory is kept unless
 * `purge` is true, so a postmortem still has the last snapshot.
 * @param {{
 *   stateDir: string,
 *   homeDir?: string,
 *   purge?: boolean,
 *   fs?: typeof fs,
 *   systemctl?: typeof systemctlUser,
 * }} options
 */
export function uninstallSampler({ stateDir, homeDir = os.homedir(), purge = false, fs: fileSystem = fs, systemctl = systemctlUser } = {}) {
  const runtime = runtimePaths(homeDir)
  const actions = []
  const diagnostics = []
  const disable = systemctl(['disable', '--now', UNIT_NAMES.timer])
  if (!disable.ok) diagnostics.push(`systemctl --user disable failed: ${disable.stderr || 'unknown error'}`)
  systemctl(['stop', UNIT_NAMES.service])
  for (const file of [runtime.timerFile, runtime.serviceFile]) {
    actions.push(`remove ${file}`)
    try { fileSystem.rmSync(file, { force: true }) } catch (error) { diagnostics.push(`remove ${file}: ${error.message}`) }
  }
  actions.push(`remove ${runtime.runtimeDir}`)
  try { fileSystem.rmSync(runtime.runtimeDir, { recursive: true, force: true }) } catch (error) { diagnostics.push(`remove runtime: ${error.message}`) }
  const reload = systemctl(['daemon-reload'])
  if (!reload.ok) diagnostics.push(`systemctl --user daemon-reload failed: ${reload.stderr || 'unknown error'}`)
  if (purge) {
    actions.push(`remove state directory ${stateDir}`)
    try { fileSystem.rmSync(stateDir, { recursive: true, force: true }) } catch (error) { diagnostics.push(`remove state: ${error.message}`) }
  } else {
    actions.push(`keep state directory ${stateDir} (use --purge to remove)`)
  }
  return { ok: diagnostics.length === 0, actions, diagnostics, stateDir, ...runtime }
}
