#!/usr/bin/env node
/**
 * `dsh-machine-status` — the CLI half.
 *
 * Same read path as the Host tool, plus the operator commands (`sample`,
 * `install`, `uninstall`, `doctor`). Nothing here runs automatically; the Host
 * plugin never invokes this file.
 */

import fs from 'node:fs'
import path from 'node:path'
import { defaultStateDir, statePaths } from '../lib/paths.mjs'
import { loadConfigFile } from '../lib/config.mjs'
import { readStatus } from '../lib/status-read.mjs'
import { readJsonl } from '../lib/read.mjs'
import { renderEvidence, renderSources, renderStatus } from '../lib/summary.mjs'
import { runSample } from '../lib/sampler.mjs'
import { installSampler, runtimePaths, systemctlUser, uninstallSampler } from '../lib/install.mjs'
import { ownVersion } from '../lib/version.mjs'
import { SCHEMA } from '../lib/schema.mjs'
import { formatAge, isoLocal } from '../lib/format.mjs'

const EXIT = { ok: 0, degraded: 2, missing: 3, error: 1 }

function usage() {
  return `dsh-machine-status ${ownVersion()}

Usage:
  dsh-machine-status status [--json] [--state-dir DIR]
  dsh-machine-status evidence <id> [--json]
  dsh-machine-status sources [--json]
  dsh-machine-status doctor [--json]
  dsh-machine-status notifications [--limit N] [--json]
  dsh-machine-status export [--finding RULE] [--json]
  dsh-machine-status sample [--json]
  dsh-machine-status install [--dry-run] [--force]
  dsh-machine-status uninstall [--purge]
  dsh-machine-status version

Options:
  --state-dir DIR  state directory (default: $DSH_MACHINE_STATUS_STATE_DIR or
                   the platform state convention; the sampler unit sets it)
  --json           machine-readable output
  --dry-run        print install actions without changing files or services
  --force          rewrite config.json during install
  --purge          also remove the state directory during uninstall

Exit codes: 0 healthy/fresh, 2 degraded/stale, 3 missing/unknown, 1 failure.`
}

function parseArgs(argv) {
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') flags.json = true
    else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--force') flags.force = true
    else if (arg === '--purge') flags.purge = true
    else if (arg === '--help' || arg === '-h') flags.help = true
    else if (arg === '--state-dir' || arg === '--root') flags.stateDir = argv[++index]
    else if (arg === '--config') flags.config = argv[++index]
    else if (arg === '--id') flags.id = argv[++index]
    else if (arg === '--finding') flags.finding = argv[++index]
    else if (arg === '--limit') flags.limit = Number(argv[++index])
    else if (!arg.startsWith('-') && flags.command === undefined) flags.command = arg
    else if (!arg.startsWith('-') && flags.arg === undefined) flags.arg = arg
  }
  return flags
}

function resolveState(flags) {
  return flags.stateDir === undefined ? defaultStateDir() : path.resolve(flags.stateDir)
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function statusExit(result) {
  if (result.freshness.state === 'missing') return EXIT.missing
  if (result.freshness.state === 'stale') return EXIT.degraded
  const overall = result.status?.overall ?? 'unknown'
  if (overall === 'healthy') return EXIT.ok
  if (overall === 'unknown') return EXIT.missing
  return EXIT.degraded
}

function cmdStatus(flags) {
  const stateDir = resolveState(flags)
  const loaded = loadConfigFile({ stateDir })
  const fileTtl = loaded.config.ttlMs
  const read = readStatus({ stateDir, ttlMs: fileTtl })
  const config = { ...loaded.config, diagnostics: [...loaded.diagnostics, ...read.diagnostics] }
  if (flags.json) {
    printJson({
      stateDir,
      source: loaded.source,
      ttlMs: fileTtl,
      freshness: read.freshness,
      overall: read.status?.overall ?? (read.snapshot === null ? 'unknown' : 'unbased'),
      snapshot: read.snapshot,
      status: read.status,
      diagnostics: config.diagnostics,
    })
  } else {
    process.stdout.write(`${renderStatus({ snapshot: read.snapshot, status: read.status, freshness: read.freshness, config, nowMs: Date.now() })}\n`)
  }
  return statusExit(read)
}

function cmdEvidence(flags) {
  const id = flags.id ?? flags.arg
  if (typeof id !== 'string' || id === '') {
    process.stderr.write('dsh-machine-status evidence: pass an evidence id from `status`.\n')
    return EXIT.error
  }
  const stateDir = resolveState(flags)
  const loaded = loadConfigFile({ stateDir })
  const read = readStatus({ stateDir, ttlMs: loaded.config.ttlMs })
  if (read.snapshot === null) {
    process.stderr.write(`dsh-machine-status evidence: no snapshot at ${read.paths.snapshot}\n`)
    return EXIT.missing
  }
  const rendered = renderEvidence({ snapshot: read.snapshot, id })
  if (flags.json) printJson({ id, ok: rendered.ok, text: rendered.text })
  else process.stdout.write(`${rendered.text}\n`)
  return rendered.ok ? EXIT.ok : EXIT.error
}

function cmdSources(flags) {
  const stateDir = resolveState(flags)
  const loaded = loadConfigFile({ stateDir })
  const read = readStatus({ stateDir, ttlMs: loaded.config.ttlMs })
  const config = { ...loaded.config, diagnostics: [...loaded.diagnostics] }
  const timer = systemctlUser(['is-active', 'dsh-machine-status.timer'])
  const sampler = timer.ok
    ? { text: `timer ${String(timer.stdout).trim() || 'active'}` }
    : { text: `timer unavailable${timer.error === null ? ` (${String(timer.stderr).trim() || 'not installed'})` : ` (${timer.error.message})`}` }
  const text = renderSources({ read, source: loaded.source, config, nowMs: Date.now(), sampler })
  if (flags.json) {
    printJson({ stateDir, source: loaded.source, paths: read.paths, freshness: read.freshness, mtimes: read.mtimes, sizes: read.sizes, loaded: read.loaded, diagnostics: read.diagnostics, sampler })
  } else {
    process.stdout.write(`${text}\n`)
  }
  return EXIT.ok
}

function cmdDoctor(flags) {
  const stateDir = resolveState(flags)
  const paths = statePaths(stateDir)
  const checks = []
  const add = (name, level, detail) => checks.push({ name, level, detail })

  let directory = true
  try {
    if (!fs.existsSync(stateDir)) directory = false
    if (directory) {
      const probe = path.join(stateDir, `.doctor-${process.pid}`)
      fs.writeFileSync(probe, 'ok', { mode: 0o600 })
      fs.rmSync(probe, { force: true })
      add('state directory', 'ok', `${stateDir} exists and is writable`)
    } else {
      add('state directory', 'warn', `${stateDir} does not exist; run install or sample`)
    }
  } catch (error) {
    add('state directory', 'fail', `${stateDir}: ${error.message}`)
  }

  const loaded = loadConfigFile({ stateDir })
  add('config', loaded.diagnostics.length === 0 ? 'ok' : 'warn', loaded.diagnostics.length === 0 ? `config source: ${loaded.source}` : loaded.diagnostics.join('; '))

  const read = readStatus({ stateDir, ttlMs: loaded.config.ttlMs })
  add('snapshot', read.snapshot === null ? 'fail' : read.freshness.state === 'fresh' ? 'ok' : 'warn',
    read.snapshot === null
      ? `no snapshot at ${paths.snapshot}`
      : `${read.freshness.state}; age ${formatAge(read.freshness.ageMs)}; ttl ${Math.round(read.freshness.ttlMs / 1000)}s`)
  add('status', read.status === null ? 'fail' : 'ok', read.status === null ? `no status at ${paths.status}` : `overall ${read.status.overall}; sample ${read.status.sampleId}`)
  add('state', read.state === null ? 'warn' : 'ok', read.state === null ? 'no persisted state yet' : `boot ${read.state.bootId ?? 'unknown'}; incidents ${Object.keys(read.state.incidents ?? {}).length}`)

  const heartbeat = read.loaded
  if (heartbeat === null) {
    add('host plugin', 'warn', 'no plugin-loaded.json; the Host tool has not loaded with this state directory')
  } else {
    const visible = heartbeat.tool?.modelFacing === true
    add('host plugin', visible ? 'ok' : 'warn', `loaded v${heartbeat.version} at ${heartbeat.loadedAt}; model-facing ${visible ? 'yes' : 'not confirmed'}`)
  }

  const runtime = runtimePaths()
  try {
    const versionFile = path.join(runtime.runtimeDir, 'VERSION')
    const runtimeVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null
    if (runtimeVersion === null) add('runtime copy', 'warn', `${runtime.runtimeDir} not installed`)
    else if (runtimeVersion !== ownVersion()) add('runtime copy', 'warn', `installed v${runtimeVersion} differs from package v${ownVersion()}; rerun install`)
    else add('runtime copy', 'ok', `${runtime.runtimeDir} v${runtimeVersion}`)
  } catch (error) {
    add('runtime copy', 'warn', error.message)
  }

  const timer = systemctlUser(['is-active', 'dsh-machine-status.timer'])
  if (timer.error !== null) add('timer', 'warn', `systemctl --user unavailable: ${timer.error.message}`)
  else if (!timer.ok) add('timer', 'warn', `timer not active (${String(timer.stderr).trim() || 'not installed'})`)
  else add('timer', 'ok', 'dsh-machine-status.timer is active')
  const service = systemctlUser(['show', 'dsh-machine-status.service', '-p', 'Result', '-p', 'ExecMainStatus', '--value'])
  if (service.ok && String(service.stdout).trim() !== '') add('sampler', 'ok', String(service.stdout).trim().replace(/\n/g, ' '))
  else if (service.error === null) add('sampler', 'warn', 'sampler service has no result yet')

  for (const diagnostic of read.diagnostics) add('document', 'warn', diagnostic)
  for (const diagnostic of loaded.diagnostics) add('config', 'warn', diagnostic)

  const failed = checks.filter(check => check.level === 'fail').length
  if (flags.json) printJson({ stateDir, checks, ok: failed === 0 })
  else {
    for (const check of checks) process.stdout.write(`[${check.level}] ${check.name}: ${check.detail}\n`)
    process.stdout.write(`doctor: ${failed === 0 ? 'no failures' : `${failed} failure(s)`}\n`)
  }
  return failed === 0 ? EXIT.ok : EXIT.error
}

function cmdNotifications(flags) {
  const stateDir = resolveState(flags)
  const paths = statePaths(stateDir)
  const limit = Number.isFinite(flags.limit) && flags.limit > 0 ? flags.limit : 20
  const read = readJsonl(paths.notifications, { limit })
  if (flags.json) printJson({ path: paths.notifications, damaged: read.damaged, rows: read.rows })
  else if (read.rows.length === 0) process.stdout.write(`no notifications at ${paths.notifications}\n`)
  else {
    for (const row of read.rows) {
      process.stdout.write(`${row.at ?? isoLocal(row.atMs)} ${row.transition} ${row.ruleId} ${row.subject} (${row.severity}) ${row.message ?? ''}\n`)
    }
    if (read.damaged > 0) process.stdout.write(`${read.damaged} damaged notification row(s) skipped\n`)
  }
  return read.error !== null && read.error.code !== 'ENOENT' ? EXIT.error : EXIT.ok
}

function cmdExport(flags) {
  const stateDir = resolveState(flags)
  const loaded = loadConfigFile({ stateDir })
  const read = readStatus({ stateDir, ttlMs: loaded.config.ttlMs })
  if (read.snapshot === null || read.status === null) {
    process.stderr.write('dsh-machine-status export: no snapshot/status to export.\n')
    return EXIT.missing
  }
  const findings = (read.status.findings ?? []).filter(finding => flags.finding === undefined || finding.ruleId === flags.finding)
  if (findings.length === 0) {
    process.stderr.write(`dsh-machine-status export: no finding matches ${flags.finding ?? '(any)'}.\n`)
    return EXIT.error
  }
  const observedAtMs = read.snapshot.completedAtMs
  const payload = {
    schema: 'dsh.machine-status/export@1',
    exportedAt: isoLocal(Date.now()),
    sampleId: read.snapshot.sampleId,
    host: read.snapshot.host?.hostname ?? null,
    observedAt: isoLocal(observedAtMs),
    observedAtMs,
    expiresAt: isoLocal(observedAtMs + loaded.config.ttlMs),
    expiresAtMs: observedAtMs + loaded.config.ttlMs,
    findings: findings.map(finding => ({
      ...finding,
      evidence: read.snapshot.evidence?.[finding.evidenceId] ?? null,
    })),
    note: 'Read-only export. Expiry is advisory: no memory consumer may treat this as current machine state after expiresAt; the receiving store must enforce it.',
  }
  if (flags.json) printJson(payload)
  else {
    process.stdout.write(`machine_status export · ${payload.sampleId} · observed ${payload.observedAt} · expires ${payload.expiresAt}\n`)
    for (const finding of payload.findings) process.stdout.write(`  ${finding.severity} ${finding.ruleId} ${finding.subject}: ${finding.message}\n`)
    process.stdout.write(`${payload.note}\n`)
  }
  return EXIT.ok
}

function cmdSample(flags) {
  const stateDir = resolveState(flags)
  const loaded = loadConfigFile({ stateDir })
  const result = runSample({ stateDir, config: loaded.config })
  const read = readStatus({ stateDir, ttlMs: loaded.config.ttlMs })
  if (flags.json) {
    printJson({ stateDir, snapshotId: result.snapshot.sampleId, status: result.status, transitions: result.transitions, diagnostics: result.diagnostics })
  } else {
    const config = { ...loaded.config, diagnostics: [...loaded.diagnostics, ...result.diagnostics] }
    process.stdout.write(`${renderStatus({ snapshot: result.snapshot, status: result.status, freshness: read.freshness, config, nowMs: Date.now() })}\n`)
    process.stdout.write(`sampled ${result.snapshot.sampleId} in ${result.snapshot.durationMs}ms\n`)
  }
  return statusExit(read)
}

function cmdInstall(flags) {
  const stateDir = resolveState(flags)
  const result = installSampler({ stateDir, dryRun: flags.dryRun === true, force: flags.force === true })
  if (flags.json) printJson(result)
  else {
    for (const action of result.actions) process.stdout.write(`${flags.dryRun ? 'would ' : ''}${action}\n`)
    for (const diagnostic of result.diagnostics) process.stdout.write(`diagnostic: ${diagnostic}\n`)
    process.stdout.write(result.ok ? 'install: the sampler timer is installed and has run once\n' : 'install: incomplete; see diagnostics\n')
  }
  return result.ok ? EXIT.ok : EXIT.error
}

function cmdUninstall(flags) {
  const stateDir = resolveState(flags)
  const result = uninstallSampler({ stateDir, purge: flags.purge === true })
  if (flags.json) printJson(result)
  else {
    for (const action of result.actions) process.stdout.write(`${action}\n`)
    for (const diagnostic of result.diagnostics) process.stdout.write(`diagnostic: ${diagnostic}\n`)
  }
  return result.ok ? EXIT.ok : EXIT.error
}

function main() {
  const flags = parseArgs(process.argv.slice(2))
  const command = flags.command ?? 'status'
  if (flags.help) {
    process.stdout.write(`${usage()}\n`)
    return EXIT.ok
  }
  switch (command) {
    case 'status': return cmdStatus(flags)
    case 'evidence': return cmdEvidence(flags)
    case 'sources': return cmdSources(flags)
    case 'doctor': return cmdDoctor(flags)
    case 'notifications': return cmdNotifications(flags)
    case 'export': return cmdExport(flags)
    case 'sample': return cmdSample(flags)
    case 'install': return cmdInstall(flags)
    case 'uninstall': return cmdUninstall(flags)
    case 'version':
      process.stdout.write(`dsh-machine-status ${ownVersion()} (node ${process.version})\n`)
      return EXIT.ok
    default:
      process.stderr.write(`dsh-machine-status: unknown command "${command}"\n\n${usage()}\n`)
      return EXIT.error
  }
}

process.exitCode = main()
