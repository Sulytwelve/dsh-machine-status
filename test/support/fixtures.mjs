/** Deterministic fixtures shared by the test files. No filesystem or clock access here. */

import { normalizeConfig } from '../../lib/config.mjs'
import { emptyState } from '../../lib/state.mjs'
import { evaluate } from '../../lib/evaluate.mjs'
import { isoLocal } from '../../lib/format.mjs'
import { statePaths } from '../../lib/paths.mjs'
import { writeJsonAtomic } from '../../lib/write.mjs'

export const GiB = 1024 ** 3
export const HOUR = 3_600_000
export const NOW = Date.UTC(2026, 10, 18, 1, 0, 0)

export function config(overrides = {}) {
  return normalizeConfig(overrides).config
}

export function state() {
  return emptyState()
}

export function clone(value) {
  return structuredClone(value)
}

export function healthySnapshot({ nowMs = NOW, bootId = 'boot-1', completedAtMs = nowMs, sampleId = 'sample-1' } = {}) {
  const sampledAtMs = completedAtMs
  return {
    schema: 'dsh.machine-status/snapshot@1',
    sampleId,
    sampler: { version: '0.1.3', node: 'v26.0.0', platform: 'linux', arch: 'x64' },
    host: { hostname: 'SULY-HPED800', bootId, machineId: 'machine-1', platform: 'linux', arch: 'x64' },
    startedAtMs: sampledAtMs - 120,
    startedAt: isoLocal(sampledAtMs - 120),
    completedAtMs,
    completedAt: isoLocal(completedAtMs),
    durationMs: 120,
    collectorTimeoutMs: 2_000,
    collectors: {
      disk: {
        status: 'ok',
        sampledAtMs,
        durationMs: 3,
        error: null,
        mounts: [
          { mount: '/', fstype: 'ext4', sizeBytes: 119 * GiB, availBytes: 107 * GiB, usedFraction: 0.10, availFraction: 0.90, error: null },
          { mount: '/srv/storage', fstype: 'btrfs', sizeBytes: 112 * GiB, availBytes: 109 * GiB, usedFraction: 0.02, availFraction: 0.98, error: null },
        ],
      },
      memory: {
        status: 'ok',
        sampledAtMs,
        durationMs: 2,
        error: null,
        totalBytes: 4 * GiB,
        availableBytes: 2.6 * GiB,
        availFraction: 0.65,
        swapTotalBytes: 2 * GiB,
        swapFreeBytes: 2 * GiB,
        load1: 0.06,
        load5: 0.04,
        load15: 0.01,
        cpuCount: 8,
      },
      services: {
        status: 'ok',
        sampledAtMs,
        durationMs: 120,
        error: null,
        units: [
          { id: 'dsh-web', unit: 'dsh-web.service', scope: 'system', status: 'ok', activeState: 'active', subState: 'running', result: 'success', execMainStatus: 0, nRestarts: 0, error: null, sampledAtMs },
          { id: 'forgejo', unit: 'forgejo.service', scope: 'system', status: 'ok', activeState: 'active', subState: 'running', result: 'success', execMainStatus: 0, nRestarts: 0, error: null, sampledAtMs },
          { id: 'memory-probe', unit: null, scope: null, status: 'unknown', error: 'plugin-hosted service has no systemd unit; no telemetry source is configured', sampledAtMs },
        ],
      },
      backup: {
        status: 'ok',
        sampledAtMs,
        durationMs: 40,
        error: null,
        job: 'forgejo-backup.service',
        timer: 'forgejo-backup.timer',
        lastResult: 'success',
        execMainStatus: 0,
        completedAtMs: sampledAtMs - 4 * HOUR,
        completedAt: isoLocal(sampledAtMs - 4 * HOUR),
        ageMs: 4 * HOUR,
        maxAgeHours: 26,
        artifact: { status: 'unknown', source: 'none', reason: 'journal evidence is opt-in (backup.journal); unit completion is the default evidence' },
        since: isoLocal(sampledAtMs - 4 * HOUR),
      },
      ipv6: {
        status: 'ok',
        sampledAtMs,
        durationMs: 9,
        error: null,
        interface: 'eno1',
        addresses: [
          { address: '2408:825c:260:b0c:8c5a:c131:1110:a', prefixLength: 128, scope: 'global', validLifetimeSec: 6359, preferredLifetimeSec: 2759, temporary: false },
        ],
        globalPrefixes: ['2408:825c:260:b0c::/64'],
      },
    },
    evidence: {
      host: { source: 'os.hostname + /proc', hostname: 'SULY-HPED800', bootId, machineId: 'machine-1' },
      'disk:/': { source: 'fs.statfs', sampledAtMs, mount: '/', fstype: 'ext4', sizeBytes: 119 * GiB, availBytes: 107 * GiB, usedFraction: 0.10, availFraction: 0.90, error: null },
      'disk:/srv/storage': { source: 'fs.statfs', sampledAtMs, mount: '/srv/storage', fstype: 'btrfs', sizeBytes: 112 * GiB, availBytes: 109 * GiB, usedFraction: 0.02, availFraction: 0.98, error: null },
      mem: { source: '/proc/meminfo', sampledAtMs, totalBytes: 4 * GiB, availableBytes: 2.6 * GiB, availFraction: 0.65 },
      load: { source: '/proc/loadavg', sampledAtMs, load1: 0.06, load5: 0.04, load15: 0.01, cpuCount: 8 },
      'svc:dsh-web': { source: 'systemctl show dsh-web.service', sampledAtMs, id: 'dsh-web', unit: 'dsh-web.service', status: 'ok', activeState: 'active', subState: 'running', result: 'success' },
      'svc:forgejo': { source: 'systemctl show forgejo.service', sampledAtMs, id: 'forgejo', unit: 'forgejo.service', status: 'ok', activeState: 'active', subState: 'running', result: 'success' },
      'svc:memory-probe': { source: 'none (plugin-hosted)', sampledAtMs, id: 'memory-probe', unit: null, status: 'unknown', error: 'plugin-hosted service has no systemd unit; no telemetry source is configured' },
      'backup:forgejo-backup.service': { source: 'systemctl show', sampledAtMs, job: 'forgejo-backup.service', lastResult: 'success', execMainStatus: 0 },
      'ipv6:eno1': { source: 'ip -6 -j addr show dev', sampledAtMs, interface: 'eno1', globalPrefixes: ['2408:825c:260:b0c::/64'] },
    },
    diagnostics: [],
  }
}

export function withSnapshot(snapshot, mutate) {
  const next = clone(snapshot)
  mutate(next)
  return next
}

export function evaluateSteps(steps, { config: cfg = config(), state: initial = emptyState() } = {}) {
  let current = initial
  const results = []
  for (const step of steps) {
    const snapshot = step.snapshot
    const result = evaluate({
      snapshot,
      state: current,
      config: cfg,
      nowMs: step.nowMs ?? snapshot?.completedAtMs ?? NOW,
      reboot: step.reboot ?? false,
    })
    results.push(result)
    current = result.state
  }
  return { results, state: current }
}

/** Write a consistent snapshot/status/state set into a temp state directory. */
export function writeFixtureState(stateDir, { snapshot = healthySnapshot(), status = null, state: persisted = emptyState() } = {}) {
  const paths = statePaths(stateDir)
  const computed = status ?? evaluate({ snapshot, state: persisted, config: config(), nowMs: snapshot.completedAtMs }).status
  writeJsonAtomic(paths.snapshot, snapshot)
  writeJsonAtomic(paths.status, computed)
  writeJsonAtomic(paths.state, persisted)
  return { paths, snapshot, status: computed }
}

/** `systemctl show` / `ip` / `journalctl` outputs for the sampler's injected runner. */
export function fixtureCommands({ uptimeSec = 100_000, fail = new Set(), journal = null } = {}) {
  const monotonic = (uptimeSec - 4 * 3_600) * 1_000_000
  const units = {
    'dsh-web.service': [
      'LoadState=loaded',
      'UnitFileState=enabled',
      'ActiveState=active',
      'SubState=running',
      'Result=success',
      'ExecMainStatus=0',
      'NRestarts=0',
      'ActiveEnterTimestamp=Wed 2026-11-18 08:40:03 +08',
      'ExecMainExitTimestamp=',
      'ExecMainExitTimestampMonotonic=0',
    ].join('\n'),
    'forgejo.service': [
      'LoadState=loaded',
      'UnitFileState=enabled',
      'ActiveState=active',
      'SubState=running',
      'Result=success',
      'ExecMainStatus=0',
      'NRestarts=0',
      'ActiveEnterTimestamp=Wed 2026-11-18 07:00:00 +08',
      'ExecMainExitTimestamp=',
      'ExecMainExitTimestampMonotonic=0',
    ].join('\n'),
    'forgejo-backup.service': [
      'Result=success',
      'ExecMainStatus=0',
      'ExecMainExitTimestamp=Wed 2026-11-18 04:35:56 +08',
      `ExecMainExitTimestampMonotonic=${monotonic}`,
      'ActiveState=inactive',
    ].join('\n'),
    'forgejo-backup.timer': [
      'ActiveState=active',
      'LastTriggerUSec=Wed 2026-11-18 04:17:26 +08',
      'NextElapseUSecRealtime=Thu 2026-11-19 04:17:26 +08',
    ].join('\n'),
  }
  const ipJson = JSON.stringify([{
    ifindex: 2,
    ifname: 'eno1',
    addr_info: [
      { family: 'inet6', local: '2408:825c:260:b0c:8c5a:c131:1110:a', prefixlen: 128, scope: 'global', valid_life_time: 6359, preferred_life_time: 2759, flags: [] },
      { family: 'inet6', local: '2408:825c:260:b0c:806d:9c14:a659:9676', prefixlen: 64, scope: 'global', valid_life_time: 6999, preferred_life_time: 3399, flags: [] },
    ],
  }])
  return (command, args) => {
    if (fail.has(command)) {
      const error = new Error(`${command} is unavailable`)
      error.code = 'ETIMEDOUT'
      throw error
    }
    if (command === 'systemctl') {
      const index = args.indexOf('show')
      const unit = index === -1 ? undefined : args[index + 1]
      if (unit !== undefined && units[unit] !== undefined) return units[unit]
      throw Object.assign(new Error(`unit ${unit} not found`), { code: 'ENOENT' })
    }
    if (command === 'ip') return ipJson
    if (command === 'journalctl') {
      if (journal !== null) return journal
      throw Object.assign(new Error('journal not readable'), { code: 'EACCES' })
    }
    throw Object.assign(new Error(`unexpected command ${command}`), { code: 'ENOENT' })
  }
}

/** Minimal `/proc` and mount table for the collectors. */
export function fixtureProcFiles({ bootId = 'boot-1', uptimeSec = 100_000 } = {}) {
  return {
    '/proc/meminfo': 'MemTotal: 4194304 kB\nMemAvailable: 2726297 kB\nSwapTotal: 2097152 kB\nSwapFree: 2097152 kB\n',
    '/proc/loadavg': '0.06 0.04 0.01 1/182 12345\n',
    '/proc/uptime': `${uptimeSec.toFixed(2)} 200000.00\n`,
    '/proc/sys/kernel/random/boot_id': `${bootId}\n`,
    '/proc/self/mounts': '/dev/nvme0n1p2 / ext4 rw,relatime 0 0\n/dev/sda1 /srv/storage btrfs rw,relatime 0 0\n',
    '/etc/machine-id': 'machine-1\n',
  }
}

/** Two plausible mounts for `statfsSync`. */
export function fixtureStatfs(mount) {
  if (mount === '/') return { bsize: 4096, blocks: 31_176_000, bfree: 28_058_400, bavail: 28_058_400, files: 0, ffree: 0 }
  if (mount === '/srv/storage') return { bsize: 4096, blocks: 29_360_128, bfree: 28_778_925, bavail: 28_778_925, files: 0, ffree: 0 }
  return undefined
}
