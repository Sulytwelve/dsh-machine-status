/** The small alert state persisted across sampler runs and Host restarts. */

import { SCHEMA } from './schema.mjs'

/**
 * A state document with no history. Every field is bounded so a damaged file
 * cannot grow the alert state without limit.
 * @returns {object}
 */
export function emptyState() {
  return {
    schema: SCHEMA.state,
    bootId: null,
    lastSampleId: null,
    lastSuccessAtMs: null,
    lastObservedAtMs: null,
    lastTransitionAtMs: null,
    rules: {},
    incidents: {},
    diskHistory: {},
    ipv6: {},
    lastGood: {},
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Accept a stored state document or start clean. Unrecognized fields are
 * dropped; a wrong schema version still degrades to an empty state instead of
 * failing the sampler.
 * @param {unknown} raw
 */
export function normalizeState(raw) {
  const base = emptyState()
  if (!plainObject(raw)) return base
  base.bootId = typeof raw.bootId === 'string' ? raw.bootId : null
  base.lastSampleId = typeof raw.lastSampleId === 'string' ? raw.lastSampleId : null
  base.lastSuccessAtMs = Number.isFinite(raw.lastSuccessAtMs) ? raw.lastSuccessAtMs : null
  base.lastObservedAtMs = Number.isFinite(raw.lastObservedAtMs) ? raw.lastObservedAtMs : null
  base.lastTransitionAtMs = Number.isFinite(raw.lastTransitionAtMs) ? raw.lastTransitionAtMs : null
  if (plainObject(raw.rules)) {
    for (const [key, value] of Object.entries(raw.rules).slice(0, 40)) {
      if (!plainObject(value)) continue
      base.rules[key] = {
        breaches: Math.max(0, Math.round(Number(value.breaches) || 0)),
        healthy: Math.max(0, Math.round(Number(value.healthy) || 0)),
        unknown: Math.max(0, Math.round(Number(value.unknown) || 0)),
        incidentOpen: value.incidentOpen === true,
        openedAtMs: Number.isFinite(value.openedAtMs) ? value.openedAtMs : null,
      }
    }
  }
  if (plainObject(raw.incidents)) {
    for (const [key, value] of Object.entries(raw.incidents).slice(0, 20)) {
      if (!plainObject(value)) continue
      base.incidents[key] = {
        key,
        ruleId: String(value.ruleId ?? ''),
        subject: String(value.subject ?? ''),
        severity: String(value.severity ?? 'warning'),
        openedAtMs: Number.isFinite(value.openedAtMs) ? value.openedAtMs : null,
        lastEvidenceId: typeof value.lastEvidenceId === 'string' ? value.lastEvidenceId : null,
        lastSeenAtMs: Number.isFinite(value.lastSeenAtMs) ? value.lastSeenAtMs : null,
      }
    }
  }
  if (plainObject(raw.diskHistory)) {
    for (const [mount, value] of Object.entries(raw.diskHistory).slice(0, 8)) {
      if (!Array.isArray(value)) continue
      base.diskHistory[mount] = value
        .filter(item => plainObject(item) && Number.isFinite(item.atMs) && Number.isFinite(item.availBytes))
        .slice(-32)
        .map(item => ({ atMs: item.atMs, availBytes: item.availBytes, bootId: typeof item.bootId === 'string' ? item.bootId : null }))
    }
  }
  if (plainObject(raw.ipv6)) {
    for (const [iface, value] of Object.entries(raw.ipv6).slice(0, 8)) {
      if (!plainObject(value)) continue
      base.ipv6[iface] = {
        globalPrefixes: Array.isArray(value.globalPrefixes) ? value.globalPrefixes.filter(item => typeof item === 'string').slice(0, 8) : [],
        atMs: Number.isFinite(value.atMs) ? value.atMs : null,
      }
    }
  }
  if (plainObject(raw.lastGood)) {
    for (const [name, value] of Object.entries(raw.lastGood).slice(0, 8)) {
      if (!plainObject(value)) continue
      base.lastGood[name] = {
        atMs: Number.isFinite(value.atMs) ? value.atMs : null,
        value: plainObject(value.value) ? value.value : null,
      }
    }
  }
  return base
}
