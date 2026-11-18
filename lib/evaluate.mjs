/**
 * Deterministic rule evaluation and the incident state machine.
 *
 * The sampler owns this evaluation because it has the single writer; the Host
 * tool and the CLI only read `status.json`. Inputs are plain JSON, the clock is
 * injected, and no I/O happens here, so every decision is reproducible in a test.
 */

import { SCHEMA } from './schema.mjs'

/** Which severity a rule produces when it breaches. */
const SEVERITY = Object.freeze({
  'disk.free.low': 'critical',
  'disk.free.drop': 'warning',
  'mem.available.low': 'warning',
  'load.high': 'warning',
  'svc.unhealthy': 'critical',
  'backup.failed': 'critical',
  'backup.stale': 'critical',
  'ipv6.global.missing': 'warning',
  'ipv6.prefix.changed': 'info',
  'collector.failed': 'warning',
  'host.reboot': 'info',
  'telemetry.gap': 'warning',
})

/** Rules that may open an incident. Telemetry loss and information never do. */
const INCIDENT_RULES = new Set([
  'disk.free.low',
  'disk.free.drop',
  'mem.available.low',
  'load.high',
  'svc.unhealthy',
  'backup.failed',
  'backup.stale',
  'ipv6.global.missing',
])

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 }

function observation(fields) {
  return {
    ruleId: fields.ruleId,
    subject: fields.subject,
    severity: fields.severity ?? (fields.outcome === 'info' ? 'info' : SEVERITY[fields.ruleId] ?? 'warning'),
    outcome: fields.outcome,
    observed: fields.observed ?? null,
    expected: fields.expected ?? null,
    evidenceId: fields.evidenceId ?? null,
    observedAtMs: fields.observedAtMs ?? null,
    message: fields.message ?? '',
    incidentEligible: fields.incidentEligible ?? INCIDENT_RULES.has(fields.ruleId),
  }
}

function failedCollector(name, error, observedAtMs) {
  return observation({
    ruleId: 'collector.failed',
    subject: name,
    outcome: 'unknown',
    observed: 'collector failed',
    expected: 'ok',
    evidenceId: `collector:${name}`,
    observedAtMs,
    message: `${name} collector failed: ${error ?? 'unknown error'}`,
  })
}

function unknownRule(ruleId, subject, reason, evidenceId, observedAtMs) {
  return observation({
    ruleId,
    subject,
    outcome: 'unknown',
    severity: 'warning',
    observed: 'unknown',
    expected: 'a fresh observation',
    evidenceId,
    observedAtMs,
    message: reason,
  })
}

function diskDrop(state, mount, current, bootId, config, nowMs) {
  const history = (state.diskHistory[mount] ?? [])
    .filter(item => item.bootId === bootId && nowMs - item.atMs <= 24 * 60 * 60 * 1000)
    .slice(-config.rules.disk.windowSamples)
  if (history.length < 2) return null
  const baseline = Math.max(...history.map(item => item.availBytes))
  const drop = baseline - current.availBytes
  if (drop <= 0) return null
  const fraction = baseline === 0 ? 0 : drop / baseline
  if (drop < config.rules.disk.dropBytes || fraction < config.rules.disk.dropFraction) return null
  return { baseline, drop, fraction }
}

/** Build every rule observation for one snapshot. */
function collectObservations(snapshot, state, config) {
  const observedAtMs = snapshot.completedAtMs
  const observations = []
  const diagnostics = []
  const collectors = snapshot.collectors ?? {}

  const disk = collectors.disk
  if (disk === undefined || disk.status === 'failed') {
    observations.push(failedCollector('disk', disk?.error, observedAtMs))
    for (const mount of config.collect.mounts) {
      observations.push(unknownRule('disk.free.low', mount, 'disk collector unavailable', `disk:${mount}`, observedAtMs))
      observations.push(unknownRule('disk.free.drop', mount, 'disk collector unavailable', `disk:${mount}`, observedAtMs))
    }
  } else {
    for (const mount of disk.mounts ?? []) {
      const evidenceId = `disk:${mount.mount}`
      if (mount.error !== null || !Number.isFinite(mount.availBytes)) {
        observations.push(unknownRule('disk.free.low', mount.mount, `mount unreadable: ${mount.error ?? 'no value'}`, evidenceId, observedAtMs))
        observations.push(unknownRule('disk.free.drop', mount.mount, `mount unreadable: ${mount.error ?? 'no value'}`, evidenceId, observedAtMs))
        continue
      }
      const low = mount.availFraction < config.rules.disk.minAvailFraction
        || mount.availBytes < config.rules.disk.minAvailBytes
      observations.push(observation({
        ruleId: 'disk.free.low',
        subject: mount.mount,
        outcome: low ? 'breach' : 'healthy',
        observed: `${mount.availBytes} bytes free (${mount.availFraction * 100}%)`,
        expected: `at least ${config.rules.disk.minAvailBytes} bytes free and ${config.rules.disk.minAvailFraction * 100}%`,
        evidenceId,
        observedAtMs,
        message: low ? `free space below the configured floor on ${mount.mount}` : '',
      }))
      const drop = diskDrop(state, mount.mount, mount, snapshot.host?.bootId, config, observedAtMs)
      observations.push(observation({
        ruleId: 'disk.free.drop',
        subject: mount.mount,
        outcome: drop === null ? 'healthy' : 'breach',
        observed: drop === null ? 'no significant drop' : `${drop.drop} bytes (${(drop.fraction * 100).toFixed(1)}%) below ${drop.baseline}`,
        expected: `a drop smaller than ${config.rules.disk.dropBytes} bytes and ${config.rules.disk.dropFraction * 100}%`,
        evidenceId,
        observedAtMs,
        message: drop === null ? '' : `free space fell sharply on ${mount.mount}`,
      }))
    }
  }

  const memory = collectors.memory
  const memoryEvidence = 'mem'
  if (memory === undefined || memory.status === 'failed') {
    observations.push(failedCollector('memory', memory?.error, observedAtMs))
    observations.push(unknownRule('mem.available.low', 'mem', 'memory collector unavailable', memoryEvidence, observedAtMs))
    observations.push(unknownRule('load.high', 'load', 'memory collector unavailable', 'load', observedAtMs))
  } else {
    const low = memory.availFraction < config.rules.memory.minAvailFraction
      || memory.availBytes < config.rules.memory.minAvailBytes
    observations.push(observation({
      ruleId: 'mem.available.low',
      subject: 'mem',
      outcome: low ? 'breach' : 'healthy',
      observed: `${memory.availBytes} bytes available (${(memory.availFraction * 100).toFixed(1)}%)`,
      expected: `at least ${config.rules.memory.minAvailBytes} bytes and ${config.rules.memory.minAvailFraction * 100}%`,
      evidenceId: memoryEvidence,
      observedAtMs,
      message: low ? 'available memory below the configured floor' : '',
    }))
    if (!Number.isFinite(memory.load1) || !Number.isFinite(memory.cpuCount)) {
      observations.push(unknownRule('load.high', 'load', 'load average or CPU count unavailable', 'load', observedAtMs))
    } else {
      const high = memory.load1 > memory.cpuCount * config.rules.load.maxRatio
      observations.push(observation({
        ruleId: 'load.high',
        subject: 'load',
        outcome: high ? 'breach' : 'healthy',
        observed: `load1 ${memory.load1} on ${memory.cpuCount} cpus`,
        expected: `load1 at most ${memory.cpuCount * config.rules.load.maxRatio}`,
        evidenceId: 'load',
        observedAtMs,
        message: high ? 'one-minute load average above the configured multiple of CPU count' : '',
      }))
    }
  }

  const services = collectors.services
  if (services === undefined || services.status === 'failed') {
    observations.push(failedCollector('services', services?.error, observedAtMs))
    for (const service of config.collect.services) {
      observations.push(unknownRule('svc.unhealthy', service.id, 'services collector unavailable', `svc:${service.id}`, observedAtMs))
    }
  } else {
    for (const service of services.units ?? []) {
      const evidenceId = `svc:${service.id}`
      if (service.status !== 'ok' || service.activeState === undefined) {
        // A plugin-hosted service has no unit by design: that is an informational
        // gap, not a degraded machine. A systemd unit that cannot be resolved is
        // missing telemetry and stays a warning.
        const informational = service.unit === null || service.unit === undefined
        observations.push(observation({
          ruleId: 'svc.unhealthy',
          subject: service.id,
          outcome: informational ? 'info' : 'unknown',
          severity: informational ? 'info' : 'warning',
          observed: 'unknown',
          expected: 'a service observation',
          evidenceId,
          observedAtMs,
          message: service.error ?? 'no telemetry for this service',
          incidentEligible: false,
        }))
        continue
      }
      const failed = service.activeState !== 'active' || (service.result !== undefined && service.result !== 'success')
      observations.push(observation({
        ruleId: 'svc.unhealthy',
        subject: service.id,
        outcome: failed ? 'breach' : 'healthy',
        observed: `${service.activeState}/${service.subState ?? 'unknown'} result=${service.result ?? 'unknown'}`,
        expected: 'active/running result=success',
        evidenceId,
        observedAtMs,
        message: failed ? `${service.id} is not healthy (${service.activeState})` : '',
      }))
    }
  }

  const backup = collectors.backup
  if (backup === undefined || backup.status === 'failed') {
    const backupEvidence = `backup:${config.collect.backup.job}`
    observations.push(failedCollector('backup', backup?.error, observedAtMs))
    observations.push(unknownRule('backup.failed', 'backup', 'backup collector unavailable', backupEvidence, observedAtMs))
    observations.push(unknownRule('backup.stale', 'backup', 'backup collector unavailable', backupEvidence, observedAtMs))
  } else {
    const evidenceId = `backup:${backup.job}`
    const known = (backup.lastResult !== undefined && backup.lastResult !== null)
      || (backup.execMainStatus !== null && backup.execMainStatus !== undefined)
    if (!known) {
      observations.push(unknownRule('backup.failed', 'backup', 'no result from the backup unit', evidenceId, observedAtMs))
    } else {
      const failed = (backup.lastResult !== undefined && backup.lastResult !== null && backup.lastResult !== 'success')
        || (backup.execMainStatus !== null && backup.execMainStatus !== 0)
      observations.push(observation({
        ruleId: 'backup.failed',
        subject: 'backup',
        outcome: failed ? 'breach' : 'healthy',
        observed: `result=${backup.lastResult ?? 'unknown'} exit=${backup.execMainStatus ?? 'unknown'}`,
        expected: 'result=success exit=0',
        evidenceId,
        observedAtMs,
        message: failed ? 'the last backup run did not report success' : '',
      }))
    }
    if (!Number.isFinite(backup.ageMs)) {
      observations.push(unknownRule('backup.stale', 'backup', 'no completion timestamp from the backup job', evidenceId, observedAtMs))
    } else {
      const stale = backup.ageMs > config.collect.backup.maxAgeHours * 60 * 60 * 1000
      observations.push(observation({
        ruleId: 'backup.stale',
        subject: 'backup',
        outcome: stale ? 'breach' : 'healthy',
        observed: `${Math.round(backup.ageMs / 60_000)} minutes since completion`,
        expected: `at most ${config.collect.backup.maxAgeHours} hours`,
        evidenceId,
        observedAtMs,
        message: stale ? 'the last successful backup is older than the policy limit' : '',
      }))
    }
  }

  const ipv6 = collectors.ipv6
  if (ipv6 === undefined || ipv6.status === 'failed') {
    observations.push(failedCollector('ipv6', ipv6?.error, observedAtMs))
    observations.push(unknownRule('ipv6.global.missing', config.collect.interface, 'ipv6 collector unavailable', `ipv6:${config.collect.interface}`, observedAtMs))
  } else {
    const evidenceId = `ipv6:${ipv6.interface}`
    const previous = state.ipv6[ipv6.interface]?.globalPrefixes ?? []
    const current = ipv6.globalPrefixes ?? []
    if (previous.length > 0 && current.length > 0 && previous.join(',') !== current.join(',')) {
      observations.push(observation({
        ruleId: 'ipv6.prefix.changed',
        subject: ipv6.interface,
        outcome: 'info',
        observed: current.join(','),
        expected: previous.join(','),
        evidenceId,
        observedAtMs,
        message: 'the global IPv6 prefix changed since the previous sample',
        incidentEligible: false,
      }))
    }
    if (current.length === 0) {
      const required = config.collect.ipv6.requireGlobal === true
      observations.push(observation({
        ruleId: 'ipv6.global.missing',
        subject: ipv6.interface,
        outcome: required ? 'breach' : 'info',
        observed: 'no global IPv6 address',
        expected: 'at least one global IPv6 address',
        evidenceId,
        observedAtMs,
        message: required ? 'the configured interface has no global IPv6 address' : 'the configured interface has no global IPv6 address (policy does not alert)',
        incidentEligible: required,
      }))
      diagnostics.push('ipv6: no global address on the configured interface')
    } else {
      observations.push(observation({
        ruleId: 'ipv6.global.missing',
        subject: ipv6.interface,
        outcome: 'healthy',
        observed: current.join(','),
        expected: 'at least one global IPv6 address',
        evidenceId,
        observedAtMs,
        incidentEligible: config.collect.ipv6.requireGlobal === true,
      }))
    }
  }

  return { observations, diagnostics }
}

/** Advance breach/healthy streaks and open or close incidents. */
function advanceMachine({ observations, state, config, nowMs, reboot }) {
  const rules = {}
  for (const [key, value] of Object.entries(state.rules ?? {})) {
    rules[key] = { ...value }
  }
  const incidents = {}
  for (const [key, value] of Object.entries(state.incidents ?? {})) incidents[key] = { ...value }
  const transitions = []

  if (reboot) {
    for (const value of Object.values(rules)) {
      value.breaches = 0
      value.healthy = 0
      value.unknown = 0
    }
  }

  for (const item of observations) {
    if (item.outcome === 'info') continue
    const key = `${item.ruleId}|${item.subject}`
    const streak = rules[key] ?? (rules[key] = { breaches: 0, healthy: 0, unknown: 0, incidentOpen: false, openedAtMs: null })
    if (item.outcome === 'breach') {
      streak.breaches += 1
      streak.healthy = 0
      if (item.incidentEligible && streak.incidentOpen !== true && streak.breaches >= config.rules.incident.openAfter) {
        streak.incidentOpen = true
        streak.openedAtMs = nowMs
        incidents[key] = {
          key,
          ruleId: item.ruleId,
          subject: item.subject,
          severity: item.severity,
          openedAtMs: nowMs,
          lastEvidenceId: item.evidenceId,
          lastSeenAtMs: nowMs,
        }
        transitions.push({
          key,
          ruleId: item.ruleId,
          subject: item.subject,
          severity: item.severity,
          transition: 'opened',
          atMs: nowMs,
          evidenceId: item.evidenceId,
          message: `${item.ruleId} on ${item.subject} opened after ${streak.breaches} consecutive breaches`,
        })
      } else if (streak.incidentOpen === true) {
        incidents[key] = { ...incidents[key], lastEvidenceId: item.evidenceId, lastSeenAtMs: nowMs }
      }
    } else if (item.outcome === 'healthy') {
      streak.healthy += 1
      streak.breaches = 0
      if (streak.incidentOpen === true && streak.healthy >= config.rules.incident.closeAfter) {
        streak.incidentOpen = false
        const closed = incidents[key]
        delete incidents[key]
        transitions.push({
          key,
          ruleId: item.ruleId,
          subject: item.subject,
          severity: closed?.severity ?? item.severity,
          transition: 'closed',
          atMs: nowMs,
          evidenceId: item.evidenceId,
          message: `${item.ruleId} on ${item.subject} closed after ${streak.healthy} consecutive healthy samples`,
        })
        streak.openedAtMs = null
      }
    } else {
      streak.unknown += 1
    }
  }

  return { rules, incidents, transitions }
}

/**
 * Evaluate one snapshot against the persisted state and produce the status
 * document, the next state, and the notification transitions (open/close only).
 *
 * @param {{
 *   snapshot: object | null,
 *   state: object,
 *   config: object,
 *   nowMs: number,
 *   reboot?: boolean,
 * }} input
 */
export function evaluate({ snapshot, state, config, nowMs, reboot = false }) {
  if (snapshot === null || snapshot === undefined) {
    return {
      status: {
        schema: SCHEMA.status,
        sampleId: null,
        host: null,
        observedAtMs: null,
        observedAt: null,
        overall: 'unknown',
        findings: [],
        incidents: [],
        counters: { healthy: 0, breach: 0, unknown: 0, info: 0 },
        collectors: {},
        diagnostics: ['no snapshot has been collected yet'],
        lastTransitionAtMs: state.lastTransitionAtMs ?? null,
      },
      state: { ...state },
      transitions: [],
    }
  }

  const { observations, diagnostics } = collectObservations(snapshot, state, config)
  const bootId = snapshot.host?.bootId ?? state.bootId ?? null

  if (reboot) {
    observations.push(observation({
      ruleId: 'host.reboot',
      subject: 'host',
      outcome: 'info',
      observed: bootId,
      expected: state.bootId,
      evidenceId: 'host',
      observedAtMs: snapshot.completedAtMs,
      message: 'the host boot id changed since the previous sample; per-rule streaks restart',
      incidentEligible: false,
    }))
  }

  const machine = advanceMachine({ observations, state, config, nowMs, reboot })

  const findings = []
  for (const item of observations) {
    if (item.outcome === 'healthy') continue
    findings.push({
      ruleId: item.ruleId,
      severity: item.severity,
      subject: item.subject,
      outcome: item.outcome,
      observed: item.observed,
      expected: item.expected,
      evidenceId: item.evidenceId,
      observedAtMs: item.observedAtMs,
      message: item.message,
    })
  }

  // A gap finding per open incident whose rule reported unknown this sample.
  for (const incident of Object.values(machine.incidents)) {
    const gap = observations.some(item => item.outcome === 'unknown' && item.ruleId === incident.ruleId && item.subject === incident.subject)
    if (gap) {
      findings.push({
        ruleId: 'telemetry.gap',
        severity: 'warning',
        subject: incident.subject,
        outcome: 'unknown',
        observed: 'no telemetry',
        expected: 'an observation for this rule',
        evidenceId: incident.lastEvidenceId,
        observedAtMs: snapshot.completedAtMs,
        message: `telemetry is missing for the open ${incident.ruleId} incident on ${incident.subject}; it cannot close`,
      })
    }
  }

  const counters = { healthy: 0, breach: 0, unknown: 0, info: 0 }
  for (const item of observations) counters[item.outcome] += 1
  const openIncidents = Object.values(machine.incidents)
  const worst = findings.reduce((rank, finding) => Math.max(rank, SEVERITY_RANK[finding.severity] ?? 0), 0)

  let overall = 'healthy'
  if (worst >= SEVERITY_RANK.warning || openIncidents.length > 0) overall = 'degraded'
  if (counters.healthy === 0 && counters.unknown > 0) overall = 'unknown'
  if (snapshot.collectors !== undefined) {
    const failed = Object.values(snapshot.collectors).filter(collector => collector.status === 'failed').length
    const total = Object.keys(snapshot.collectors).length
    if (total > 0 && failed === total) overall = 'unknown'
  }

  const nextState = {
    ...state,
    bootId,
    lastSampleId: snapshot.sampleId,
    lastSuccessAtMs: snapshot.completedAtMs,
    lastObservedAtMs: snapshot.completedAtMs,
    rules: machine.rules,
    incidents: machine.incidents,
    lastTransitionAtMs: machine.transitions.length > 0
      ? machine.transitions[machine.transitions.length - 1].atMs
      : (state.lastTransitionAtMs ?? null),
    diskHistory: { ...state.diskHistory },
    ipv6: { ...state.ipv6 },
  }

  const disk = snapshot.collectors?.disk
  if (disk?.status === 'ok') {
    for (const mount of disk.mounts ?? []) {
      if (!Number.isFinite(mount.availBytes)) continue
      const entries = (nextState.diskHistory[mount.mount] ?? [])
        .filter(item => item.bootId === bootId)
        .slice(-config.rules.disk.windowSamples)
      entries.push({ atMs: snapshot.completedAtMs, availBytes: mount.availBytes, bootId })
      nextState.diskHistory[mount.mount] = entries.slice(-config.rules.disk.windowSamples)
    }
  }
  const ipv6 = snapshot.collectors?.ipv6
  if (ipv6?.status === 'ok' && Array.isArray(ipv6.globalPrefixes)) {
    nextState.ipv6[ipv6.interface] = { globalPrefixes: ipv6.globalPrefixes.slice(0, 8), atMs: snapshot.completedAtMs }
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || a.ruleId.localeCompare(b.ruleId))

  return {
    status: {
      schema: SCHEMA.status,
      sampleId: snapshot.sampleId,
      host: snapshot.host?.hostname ?? null,
      observedAtMs: snapshot.completedAtMs,
      observedAt: snapshot.completedAt ?? null,
      overall,
      findings,
      incidents: openIncidents
        .slice()
        .sort((a, b) => (a.openedAtMs ?? 0) - (b.openedAtMs ?? 0))
        .map(incident => ({ ...incident })),
      counters,
      collectors: Object.fromEntries(
        Object.entries(snapshot.collectors ?? {}).map(([name, collector]) => [name, collector.status ?? 'unknown']),
      ),
      diagnostics,
      lastTransitionAtMs: nextState.lastTransitionAtMs,
    },
    state: nextState,
    transitions: machine.transitions,
  }
}

export { SEVERITY, INCIDENT_RULES }
