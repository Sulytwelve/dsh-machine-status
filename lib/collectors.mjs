/**
 * Read-only collectors. Each one returns plain values plus an evidence record;
 * every external command has a timeout, and a failure is data (status failed or
 * unknown) rather than an exception. The runner and filesystem are injectable so
 * tests can drive exact outputs without a Linux host.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Run one fixed command with a hard timeout. No shell, no user input, no writes.
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number}} options
 * @returns {string} stdout
 */
export function defaultRunner(command, args, { timeoutMs = 2_000 } = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function readTrim(fileSystem, file) {
  try {
    return String(fileSystem.readFileSync(file, 'utf8')).trim()
  } catch {
    return null
  }
}

function errorOf(error) {
  const stderr = typeof error?.stderr === 'string' && error.stderr.trim() !== '' ? `: ${error.stderr.trim().slice(0, 200)}` : ''
  return `${error?.code ?? 'ERR'} ${error?.message ?? String(error)}${stderr}`.slice(0, 300)
}

/** Parse `systemctl show` key=value output into a flat object. */
export function parseSystemctlShow(text) {
  const props = {}
  for (const line of String(text).split('\n')) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key === '') continue
    props[key] = line.slice(index + 1).trim()
  }
  return props
}

/** `/proc/meminfo` and `/proc/loadavg` reader with an OS fallback for other platforms. */
export function collectMemory({ fs: fileSystem = fs, nowMs = Date.now() } = {}) {
  const sampledAtMs = nowMs
  const totalmem = os.totalmem()
  const freemem = os.freemem()
  const meminfo = readTrim(fileSystem, '/proc/meminfo')
  const loadavg = readTrim(fileSystem, '/proc/loadavg')
  let totalBytes = totalmem
  let availableBytes = freemem
  let swapTotalBytes = null
  let swapFreeBytes = null
  let source = 'os.totalmem/os.freemem'
  if (meminfo !== null) {
    const values = {}
    for (const line of meminfo.split('\n')) {
      const match = /^([A-Za-z]+):\s+(\d+)\s*kB$/.exec(line)
      if (match !== null) values[match[1]] = Number(match[2]) * 1024
    }
    if (Number.isFinite(values.MemTotal)) totalBytes = values.MemTotal
    if (Number.isFinite(values.MemAvailable)) availableBytes = values.MemAvailable
    swapTotalBytes = Number.isFinite(values.SwapTotal) ? values.SwapTotal : null
    swapFreeBytes = Number.isFinite(values.SwapFree) ? values.SwapFree : null
    source = '/proc/meminfo'
  }
  let load = [null, null, null]
  if (loadavg !== null) {
    const parts = loadavg.split(/\s+/).slice(0, 3).map(Number)
    if (parts.length === 3 && parts.every(Number.isFinite)) load = parts
  }
  const cpuCount = os.cpus().length
  return {
    status: 'ok',
    sampledAtMs,
    totalBytes,
    availableBytes,
    availFraction: totalBytes > 0 ? availableBytes / totalBytes : null,
    swapTotalBytes,
    swapFreeBytes,
    load1: load[0],
    load5: load[1],
    load15: load[2],
    cpuCount,
    source,
  }
}

/**
 * Read `statfs` for each configured mount. A mount that cannot be read keeps its
 * error; the collector fails only when no mount at all could be read.
 */
export function collectDisk({ config, fs: fileSystem = fs, nowMs = Date.now() } = {}) {
  const mounts = config.collect.mounts
  const fstypes = new Map()
  const mountTable = readTrim(fileSystem, '/proc/self/mounts')
  if (mountTable !== null) {
    for (const line of mountTable.split('\n')) {
      const parts = line.split(' ')
      if (parts.length >= 3) fstypes.set(parts[1].replace(/\\040/g, ' '), parts[2])
    }
  }
  const results = []
  let readable = 0
  for (const mount of mounts) {
    try {
      const stat = fileSystem.statfsSync(mount)
      const sizeBytes = stat.blocks * stat.bsize
      const availBytes = stat.bavail * stat.bsize
      readable += 1
      results.push({
        mount,
        fstype: fstypes.get(mount) ?? null,
        sizeBytes,
        availBytes,
        usedFraction: stat.blocks > 0 ? 1 - stat.bfree / stat.blocks : null,
        availFraction: stat.blocks > 0 ? stat.bavail / stat.blocks : null,
        error: null,
      })
    } catch (error) {
      results.push({ mount, fstype: fstypes.get(mount) ?? null, sizeBytes: null, availBytes: null, usedFraction: null, availFraction: null, error: errorOf(error) })
    }
  }
  return {
    status: readable === 0 ? 'failed' : 'ok',
    sampledAtMs: nowMs,
    mounts: results,
    error: readable === 0 ? 'no configured mount could be read' : null,
  }
}

/** Resolve one systemd unit's state with `systemctl show` (read-only). */
function systemdUnit({ config, runner, service, nowMs }) {
  const scopeArgs = service.scope === 'user' ? ['--user'] : []
  const output = runner('systemctl', [
    ...scopeArgs,
    'show',
    service.unit,
    '--no-pager',
    '-p', 'LoadState',
    '-p', 'UnitFileState',
    '-p', 'ActiveState',
    '-p', 'SubState',
    '-p', 'Result',
    '-p', 'ExecMainStatus',
    '-p', 'NRestarts',
    '-p', 'ActiveEnterTimestamp',
    '-p', 'ExecMainExitTimestamp',
    '-p', 'ExecMainExitTimestampMonotonic',
  ], { timeoutMs: config.collectorTimeoutMs, nowMs })
  const props = parseSystemctlShow(output)
  if (props.LoadState === 'not-found') {
    return { id: service.id, unit: service.unit, scope: service.scope, status: 'unknown', error: 'unit not found', sampledAtMs: nowMs }
  }
  const execStatus = props.ExecMainStatus === undefined || props.ExecMainStatus === '' ? null : Number(props.ExecMainStatus)
  return {
    id: service.id,
    unit: service.unit,
    scope: service.scope,
    status: 'ok',
    loadState: props.LoadState ?? null,
    unitFileState: props.UnitFileState ?? null,
    activeState: props.ActiveState ?? 'unknown',
    subState: props.SubState ?? null,
    result: props.Result ?? null,
    execMainStatus: Number.isFinite(execStatus) ? execStatus : null,
    nRestarts: Number.isFinite(Number(props.NRestarts)) ? Number(props.NRestarts) : null,
    activeEnterTimestamp: props.ActiveEnterTimestamp ?? null,
    execMainExitTimestamp: props.ExecMainExitTimestamp ?? null,
    execMainExitTimestampMonotonicUs: Number.isFinite(Number(props.ExecMainExitTimestampMonotonic))
      ? Number(props.ExecMainExitTimestampMonotonic)
      : null,
    sampledAtMs: nowMs,
  }
}

/**
 * Resolve the configured service list. A plugin-hosted service (one with no
 * systemd unit) is reported unknown with a diagnostic rather than guessed.
 */
export function collectServices({ config, runner = defaultRunner, nowMs = Date.now() } = {}) {
  const units = []
  let resolved = 0
  for (const service of config.collect.services) {
    if (service.kind !== 'systemd') {
      units.push({
        id: service.id,
        unit: null,
        scope: null,
        status: 'unknown',
        error: 'plugin-hosted service has no systemd unit; no telemetry source is configured',
        sampledAtMs: nowMs,
      })
      continue
    }
    try {
      const unit = systemdUnit({ config, runner, service, nowMs })
      if (unit.status === 'ok') resolved += 1
      units.push(unit)
    } catch (error) {
      units.push({ id: service.id, unit: service.unit, scope: service.scope, status: 'unknown', error: errorOf(error), sampledAtMs: nowMs })
    }
  }
  return {
    status: resolved === 0 ? 'failed' : 'ok',
    sampledAtMs: nowMs,
    units,
    error: resolved === 0 ? 'no configured service unit could be resolved' : null,
  }
}

function uptimeSeconds(fileSystem) {
  const text = readTrim(fileSystem, '/proc/uptime')
  if (text === null) return null
  const value = Number(text.split(' ')[0])
  return Number.isFinite(value) ? value : null
}

function readJournalArtifact({ config, runner, job, timeoutMs }) {
  try {
    const output = runner('journalctl', ['-u', job, '-n', '80', '--no-pager', '-o', 'cat'], { timeoutMs })
    const countMatch = /云端当前日备份数：(\d+)/.exec(output)
    const lines = String(output).trim().split('\n')
    const done = lines.some(line => line.trim() === '完成')
    return {
      status: done ? 'observed' : 'unknown',
      source: 'journal',
      dailyCount: countMatch === null ? null : Number(countMatch[1]),
      line: lines.slice(-1)[0]?.slice(0, 200) ?? null,
    }
  } catch (error) {
    return { status: 'unknown', source: 'journal', error: errorOf(error) }
  }
}

/**
 * Backup freshness from the job's own systemd completion record. The unit exit
 * timestamp is evidence of the whole run, not a touched directory; the artifact
 * line from the journal stays opt-in because the `dsh` user cannot read other
 * units' journals by default.
 */
export function collectBackup({ config, runner = defaultRunner, fs: fileSystem = fs, nowMs = Date.now() } = {}) {
  const { job, timer, maxAgeHours } = config.collect.backup
  if (typeof job !== 'string' || job === '') {
    return { status: 'unknown', sampledAtMs: nowMs, job, error: 'no backup job configured' }
  }
  try {
    const output = runner('systemctl', [
      'show', job, '--no-pager',
      '-p', 'Result',
      '-p', 'ExecMainStatus',
      '-p', 'ExecMainExitTimestamp',
      '-p', 'ExecMainExitTimestampMonotonic',
      '-p', 'ActiveState',
    ], { timeoutMs: config.collectorTimeoutMs, nowMs })
    const props = parseSystemctlShow(output)
    let timerProps = {}
    if (typeof timer === 'string' && timer !== '') {
      try {
        timerProps = parseSystemctlShow(runner('systemctl', [
          'show', timer, '--no-pager',
          '-p', 'ActiveState',
          '-p', 'LastTriggerUSec',
          '-p', 'NextElapseUSecRealtime',
        ], { timeoutMs: config.collectorTimeoutMs, nowMs }))
      } catch {
        timerProps = {}
      }
    }
    const uptime = uptimeSeconds(fileSystem)
    const monotonicUs = Number(props.ExecMainExitTimestampMonotonic)
    const completedAtMs = Number.isFinite(monotonicUs) && monotonicUs > 0 && uptime !== null
      ? nowMs - uptime * 1000 + monotonicUs / 1000
      : null
    const execMainStatus = props.ExecMainStatus === undefined || props.ExecMainStatus === '' ? null : Number(props.ExecMainStatus)
    const artifact = config.collect.backup.journal === true
      ? readJournalArtifact({ config, runner, job, timeoutMs: config.collectorTimeoutMs })
      : { status: 'unknown', source: 'none', reason: 'journal evidence is opt-in (backup.journal); unit completion is the default evidence' }
    return {
      status: 'ok',
      sampledAtMs: nowMs,
      job,
      timer: timer || null,
      lastResult: props.Result ?? null,
      execMainStatus: Number.isFinite(execMainStatus) ? execMainStatus : null,
      completedAtMs,
      completedAt: completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
      ageMs: completedAtMs === null ? null : Math.max(0, nowMs - completedAtMs),
      maxAgeHours,
      activeState: props.ActiveState ?? null,
      timerState: timerProps.ActiveState ?? null,
      timerLastTrigger: timerProps.LastTriggerUSec ?? null,
      timerNextElapse: timerProps.NextElapseUSecRealtime ?? null,
      artifact,
      raw: {
        execMainExitTimestamp: props.ExecMainExitTimestamp ?? null,
        execMainExitTimestampMonotonicUs: Number.isFinite(monotonicUs) ? monotonicUs : null,
      },
    }
  } catch (error) {
    return { status: 'failed', sampledAtMs: nowMs, job, error: errorOf(error) }
  }
}

function expandIpv6(address) {
  const bare = String(address).split('%')[0]
  if (!bare.includes(':')) return null
  const halves = bare.split('::')
  if (halves.length > 2) return null
  const left = halves[0] === '' ? [] : halves[0].split(':')
  const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    return [...left, ...Array(missing).fill('0'), ...right].map(group => Number.parseInt(group, 16))
  }
  if (left.length !== 8) return null
  return left.map(group => Number.parseInt(group, 16))
}

/**
 * The /64 network prefix of a global address; null for a malformed address.
 * Privacy-extension /128 addresses share this prefix, so prefix rotation is
 * reported once per interface rather than per address.
 * @param {string} address
 * @returns {string | null}
 */
export function prefix64(address) {
  const groups = expandIpv6(address)
  if (groups === null || groups.some(group => !Number.isFinite(group))) return null
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`
}

/** Global IPv6 addresses and their /64 prefixes for one interface. */
export function collectIpv6({ config, runner = defaultRunner, nowMs = Date.now() } = {}) {
  const iface = config.collect.interface
  if (typeof iface !== 'string' || iface === '') {
    return { status: 'unknown', sampledAtMs: nowMs, interface: iface, error: 'no interface configured' }
  }
  try {
    const output = runner('ip', ['-6', '-j', 'addr', 'show', 'dev', iface], { timeoutMs: config.collectorTimeoutMs, nowMs })
    const parsed = JSON.parse(output)
    const addresses = []
    for (const entry of Array.isArray(parsed) ? parsed : []) {
      for (const info of entry.addr_info ?? []) {
        if (info.family !== 'inet6' || info.scope !== 'global') continue
        addresses.push({
          address: info.local,
          prefixLength: info.prefixlen,
          scope: info.scope,
          validLifetimeSec: info.valid_life_time ?? null,
          preferredLifetimeSec: info.preferred_life_time ?? null,
          temporary: Array.isArray(info.flags) && info.flags.includes('temporary'),
        })
      }
    }
    const prefixes = [...new Set(addresses.map(item => prefix64(item.address)).filter(item => item !== null))].sort()
    return {
      status: 'ok',
      sampledAtMs: nowMs,
      interface: iface,
      addresses,
      globalPrefixes: prefixes,
      error: null,
    }
  } catch (error) {
    return { status: 'failed', sampledAtMs: nowMs, interface: iface, error: errorOf(error) }
  }
}

/** Host identity and boot id; both are needed to compare samples across restarts. */
export function collectHost({ fs: fileSystem = fs } = {}) {
  const bootId = readTrim(fileSystem, '/proc/sys/kernel/random/boot_id')
  const machineId = readTrim(fileSystem, '/etc/machine-id') ?? readTrim(fileSystem, '/var/lib/dbus/machine-id')
  return {
    hostname: os.hostname(),
    bootId: bootId === null ? null : bootId,
    machineId: machineId === null ? null : machineId,
    platform: process.platform,
    arch: process.arch,
  }
}
