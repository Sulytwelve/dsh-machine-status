/**
 * Model-facing and CLI-facing text. The Host tool returns exactly this text, so
 * the budget is a hard cap on what a repeated status call costs the context.
 */

import { clockLocal, formatAge, formatBytes, formatPercent, isoLocal } from './format.mjs'

const MAX_FINDINGS = 5
const MAX_INCIDENTS = 3
const MAX_EVIDENCE_IDS = 14

function collectorNote(name, collector) {
  if (collector === undefined) return `${name} unknown (collector missing)`
  if (collector.status === 'ok') return null
  return `${name} unknown (${collector.error ?? collector.status})`
}

function serviceLine(snapshot) {
  const collector = snapshot.collectors?.services
  if (collector === undefined) return null
  const units = collector.units ?? []
  if (units.length === 0) return 'services none configured'
  return `services ${units.map(unit => {
    if (unit.status !== 'ok') return `${unit.id} unknown (${unit.error ?? 'no telemetry'})`
    return `${unit.id} ${unit.activeState}/${unit.subState ?? 'unknown'}${unit.result === 'success' ? '' : ` result=${unit.result ?? 'unknown'}`}`
  }).join(' · ')}`
}

function backupLine(snapshot) {
  const backup = snapshot.collectors?.backup
  if (backup === undefined) return null
  if (backup.status !== 'ok') return `backup unknown (${backup.error ?? backup.status})`
  const age = Number.isFinite(backup.ageMs) ? `${formatAge(backup.ageMs)} ago` : 'completion unknown'
  const artifact = backup.artifact === undefined
    ? 'artifact unknown'
    : backup.artifact.status === 'observed'
      ? `artifact ${backup.artifact.dailyCount ?? '?'} daily`
      : `artifact ${backup.artifact.status}${backup.artifact.reason === undefined ? '' : ` (${backup.artifact.reason})`}`
  return `backup ${backup.job} ${backup.lastResult ?? 'unknown'}/${backup.execMainStatus ?? 'unknown'} · last completion ${age} (limit ${backup.maxAgeHours}h) · ${artifact}`
}

function ipv6Line(snapshot) {
  const ipv6 = snapshot.collectors?.ipv6
  if (ipv6 === undefined) return null
  if (ipv6.status !== 'ok') return `ipv6 unknown (${ipv6.error ?? ipv6.status})`
  const prefixes = ipv6.globalPrefixes ?? []
  return `ipv6     ${ipv6.interface} ${prefixes.length === 0 ? 'no global address' : prefixes.join(', ')}`
}

function findingLine(finding) {
  const observed = typeof finding.observed === 'string' && finding.observed !== '' ? ` observed=${finding.observed}` : ''
  const expected = typeof finding.expected === 'string' && finding.expected !== '' ? ` expected=${finding.expected}` : ''
  return `  [${finding.severity}] ${finding.ruleId} ${finding.subject}: ${finding.message || 'attention needed'}${observed}${expected} evidence=${finding.evidenceId ?? 'none'}`
}

/**
 * The compact summary. Fresh samples list each source; stale and missing samples
 * say so first and never present old values as current.
 * @param {{snapshot: object|null, status: object|null, freshness: object, config: object, nowMs: number}} input
 * @returns {string}
 */
export function renderStatus({ snapshot, status, freshness, config, nowMs }) {
  const ttlText = `${Math.round(freshness.ttlMs / 1000)}s`
  const lines = []

  if (snapshot === null) {
    lines.push('machine_status: MISSING · no snapshot has been collected')
    for (const diagnostic of config.diagnostics ?? []) lines.push(`diagnostic: ${diagnostic}`)
    lines.push(`diagnostic: no sample at the configured state directory. Run \`dsh-machine-status install\` as the DSH user, or check the sampler timer.`)
    return lines.join('\n')
  }

  const host = snapshot.host?.hostname ?? 'unknown-host'
  const observedText = isoLocal(snapshot.completedAtMs)
  if (freshness.state === 'stale') {
    lines.push(`machine_status: STALE · ${host} · last sample ${observedText} · ${formatAge(freshness.ageMs)} old (ttl ${ttlText})`)
    if (status !== null) {
      lines.push(`last known: ${String(status.overall ?? 'unknown').toUpperCase()} · findings ${status.findings?.length ?? 0} · open incidents ${status.incidents?.length ?? 0}`)
    } else {
      lines.push('last known: unknown (no status.json)')
    }
    lines.push('diagnostic: reading never samples; this is not current machine state. Run `dsh-machine-status doctor`.')
    return lines.join('\n')
  }

  const overall = status?.overall ?? 'unknown'
  lines.push(`machine_status: ${String(overall).toUpperCase()} · ${host} · sample ${observedText} · ${formatAge(freshness.ageMs)} old (ttl ${ttlText})`)

  const disk = snapshot.collectors?.disk
  if (disk?.status === 'ok') {
    const mounts = (disk.mounts ?? []).map(mount => mount.error === null
      ? `${mount.mount} ${formatPercent(mount.usedFraction)} used, ${formatBytes(mount.availBytes)} free`
      : `${mount.mount} unreadable (${mount.error})`)
    lines.push(`disk     ${mounts.join(' · ')}`)
  } else {
    lines.push(`disk     unknown (${disk?.error ?? 'collector missing'})`)
  }

  const memory = snapshot.collectors?.memory
  if (memory?.status === 'ok') {
    const load = Number.isFinite(memory.load1) ? `load ${memory.load1} ${memory.load5} ${memory.load15}` : 'load unknown'
    lines.push(`memory   ${formatBytes(memory.availableBytes)} available / ${formatBytes(memory.totalBytes)} · ${load} · ${memory.cpuCount} cpus`)
  } else {
    lines.push(`memory   unknown (${memory?.error ?? 'collector missing'})`)
  }

  const services = serviceLine(snapshot)
  if (services !== null) lines.push(services)

  const backup = backupLine(snapshot)
  if (backup !== null) lines.push(backup)

  const ipv6 = ipv6Line(snapshot)
  if (ipv6 !== null) lines.push(ipv6)

  const findings = status?.findings ?? []
  const incidents = status?.incidents ?? []
  lines.push(`findings ${findings.length} · incidents ${incidents.length}`)
  for (const finding of findings.slice(0, MAX_FINDINGS)) lines.push(findingLine(finding))
  if (findings.length > MAX_FINDINGS) lines.push(`  … ${findings.length - MAX_FINDINGS} more finding(s)`)
  for (const incident of incidents.slice(0, MAX_INCIDENTS)) {
    lines.push(`incident [open] ${incident.ruleId} ${incident.subject} since ${clockLocal(incident.openedAtMs)} evidence=${incident.lastEvidenceId ?? 'none'}`)
  }
  if (incidents.length > MAX_INCIDENTS) lines.push(`  … ${incidents.length - MAX_INCIDENTS} more incident(s)`)

  const notes = [
    collectorNote('disk', snapshot.collectors?.disk),
    collectorNote('memory', snapshot.collectors?.memory),
    collectorNote('services', snapshot.collectors?.services),
    collectorNote('backup', snapshot.collectors?.backup),
    collectorNote('ipv6', snapshot.collectors?.ipv6),
  ].filter(note => note !== null)
  for (const note of notes) lines.push(`diagnostic: ${note}`)

  const evidenceIds = Object.keys(snapshot.evidence ?? {})
  if (evidenceIds.length > 0) {
    const shown = evidenceIds.slice(0, MAX_EVIDENCE_IDS)
    const more = evidenceIds.length > shown.length ? ` …+${evidenceIds.length - shown.length}` : ''
    lines.push(`evidence ${shown.join(' ')}${more}`)
  }
  if (config.probeNote !== undefined) lines.push(config.probeNote)
  return lines.join('\n')
}

/**
 * Drill-down for one evidence id. Bounded so a single call cannot flood the context.
 * @param {{snapshot: object, id: string}} input
 * @returns {{ok: boolean, text: string}}
 */
export function renderEvidence({ snapshot, id }) {
  const evidence = snapshot.evidence ?? {}
  if (evidence[id] === undefined) {
    const available = Object.keys(evidence)
    const shown = available.slice(0, 20).join(', ')
    return { ok: false, text: `machine_status evidence: unknown id "${id}". Available: ${shown || 'none'}` }
  }
  const detail = JSON.stringify(evidence[id], null, 2)
  const clipped = detail.length > 2_800 ? `${detail.slice(0, 2_800)}\n… truncated` : detail
  return {
    ok: true,
    text: `machine_status evidence ${id} · sample ${snapshot.sampleId} · sampled ${isoLocal(snapshot.completedAtMs)}\n${clipped}`,
  }
}

/**
 * Paths, freshness, heartbeat and sampler state. This is the diagnostic view for
 * a human, not a health claim.
 * @param {{read: object, source: string, config: object, nowMs: number, sampler?: object|null}} input
 * @returns {string}
 */
export function renderSources({ read, source, config, nowMs, sampler = null }) {
  const { paths, freshness, mtimes, sizes, loaded } = read
  const lines = ['machine_status sources (read-only)']
  lines.push(`state    ${paths.dir} (config ${source})`)
  lines.push(`snapshot ${paths.snapshot} · ${freshness.state} · age ${formatAge(freshness.ageMs)} · ttl ${Math.round(freshness.ttlMs / 1000)}s · ${sizes.snapshot ?? 0} bytes · mtime ${isoLocal(mtimes.snapshot)}`)
  lines.push(`status   ${paths.status} · ${sizes.status ?? 0} bytes · mtime ${isoLocal(mtimes.status)}`)
  lines.push(`state    ${paths.state} · ${sizes.state ?? 0} bytes · mtime ${isoLocal(mtimes.state)}`)
  lines.push(`plugin   ${loaded === null ? 'no heartbeat yet (the Host tool has not loaded in this state directory)' : `loaded v${loaded.version} at ${loaded.loadedAt} · model-facing tool ${loaded.tool?.modelFacing === true ? 'visible' : 'not confirmed'}`}`)
  if (sampler !== null) lines.push(`sampler  ${sampler.text}`)
  for (const diagnostic of read.diagnostics ?? []) lines.push(`diagnostic ${diagnostic}`)
  for (const diagnostic of config.diagnostics ?? []) lines.push(`diagnostic ${diagnostic}`)
  lines.push(`now      ${isoLocal(nowMs)}`)
  return lines.join('\n')
}
