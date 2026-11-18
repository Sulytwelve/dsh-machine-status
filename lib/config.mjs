/**
 * Configuration defaults and normalization.
 *
 * Every numeric default below is **calibrate-required** unless a doc table says
 * otherwise: they are starting policies from the implementation brief, not
 * measurements. The sampler, the CLI and the Host tool all read this one shape.
 */

import fs from 'node:fs'
import { readJson } from './read.mjs'

/** Starting policy. See README.md for the calibrate-required provenance table. */
export const DEFAULT_CONFIG = Object.freeze({
  schema: 1,
  ttlMs: 180_000,
  collectorTimeoutMs: 2_000,
  collect: {
    mounts: ['/', '/srv/storage'],
    interface: 'eno1',
    services: [
      { id: 'dsh-web', kind: 'systemd', unit: 'dsh-web.service', scope: 'system' },
      { id: 'forgejo', kind: 'systemd', unit: 'forgejo.service', scope: 'system' },
      { id: 'memory-probe', kind: 'plugin', row: 'memory-probe', telemetry: 'none', hint: 'plugin-hosted service has no systemd unit; no telemetry source is configured' },
    ],
    backup: {
      job: 'forgejo-backup.service',
      timer: 'forgejo-backup.timer',
      maxAgeHours: 26,
      journal: false,
    },
    ipv6: { requireGlobal: false },
  },
  rules: {
    disk: {
      minAvailFraction: 0.10,
      minAvailBytes: 2_147_483_648,
      dropFraction: 0.20,
      dropBytes: 1_073_741_824,
      windowSamples: 6,
    },
    memory: { minAvailFraction: 0.10, minAvailBytes: 536_870_912 },
    load: { maxRatio: 2 },
    incident: { openAfter: 2, closeAfter: 2 },
  },
  notify: { enabled: false },
  retention: { notifications: 512 },
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge plain objects; arrays and scalars from `override` win. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return Array.isArray(base) ? base.slice() : base
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(base?.[key])) out[key] = mergeConfig(base[key], value)
    else out[key] = value
  }
  return out
}

function finite(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function stringList(value, fallback, { max = 8, maxItem = 200 } = {}) {
  if (!Array.isArray(value)) return fallback
  const items = value
    .filter(item => typeof item === 'string' && item.trim() !== '')
    .slice(0, max)
    .map(item => item.trim().slice(0, maxItem))
  return items.length === 0 ? fallback : items
}

function serviceList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  const services = []
  for (const raw of value.slice(0, 12)) {
    if (!isPlainObject(raw)) continue
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim().slice(0, 80) : undefined
    if (id === undefined) continue
    if (raw.kind === 'plugin') {
      services.push({
        id,
        kind: 'plugin',
        row: typeof raw.row === 'string' ? raw.row.slice(0, 80) : id,
        telemetry: raw.telemetry === 'none' ? 'none' : 'auto',
        ...(typeof raw.hint === 'string' && raw.hint !== '' ? { hint: raw.hint.slice(0, 200) } : {}),
      })
      continue
    }
    const unit = typeof raw.unit === 'string' && raw.unit.trim() !== '' ? raw.unit.trim().slice(0, 120) : undefined
    if (unit === undefined) continue
    services.push({
      id,
      kind: 'systemd',
      unit,
      scope: raw.scope === 'user' ? 'user' : 'system',
      telemetry: raw.telemetry === 'none' ? 'none' : 'auto',
      ...(typeof raw.hint === 'string' && raw.hint !== '' ? { hint: raw.hint.slice(0, 200) } : {}),
    })
  }
  return services.length === 0 ? fallback : services
}

/**
 * Merge caller input over defaults and coerce every field back into a sane range.
 * Invalid values fall back to the default and produce a diagnostic; normalization
 * never throws, so a bad config degrades instead of blocking activation.
 * @param {unknown} raw
 * @returns {{config: typeof DEFAULT_CONFIG, diagnostics: string[]}}
 */
export function normalizeConfig(raw) {
  const diagnostics = []
  const merged = mergeConfig(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {})
  const base = DEFAULT_CONFIG

  const config = {
    schema: 1,
    ttlMs: finite(merged.ttlMs, base.ttlMs, { min: 1_000, max: 86_400_000 }),
    collectorTimeoutMs: finite(merged.collectorTimeoutMs, base.collectorTimeoutMs, { min: 200, max: 30_000 }),
    collect: {
      mounts: stringList(merged.collect?.mounts, base.collect.mounts),
      interface: typeof merged.collect?.interface === 'string' && merged.collect.interface.trim() !== ''
        ? merged.collect.interface.trim().slice(0, 64)
        : base.collect.interface,
      services: serviceList(merged.collect?.services, base.collect.services),
      backup: {
        job: typeof merged.collect?.backup?.job === 'string' && merged.collect.backup.job.trim() !== ''
          ? merged.collect.backup.job.trim().slice(0, 120)
          : base.collect.backup.job,
        timer: typeof merged.collect?.backup?.timer === 'string' && merged.collect.backup.timer.trim() !== ''
          ? merged.collect.backup.timer.trim().slice(0, 120)
          : base.collect.backup.timer,
        maxAgeHours: finite(merged.collect?.backup?.maxAgeHours, base.collect.backup.maxAgeHours, { min: 1, max: 24 * 30 }),
        journal: merged.collect?.backup?.journal === true,
      },
      ipv6: { requireGlobal: merged.collect?.ipv6?.requireGlobal === true },
    },
    rules: {
      disk: {
        minAvailFraction: finite(merged.rules?.disk?.minAvailFraction, base.rules.disk.minAvailFraction, { min: 0, max: 1 }),
        minAvailBytes: finite(merged.rules?.disk?.minAvailBytes, base.rules.disk.minAvailBytes, { min: 0, max: 1e15 }),
        dropFraction: finite(merged.rules?.disk?.dropFraction, base.rules.disk.dropFraction, { min: 0, max: 1 }),
        dropBytes: finite(merged.rules?.disk?.dropBytes, base.rules.disk.dropBytes, { min: 0, max: 1e15 }),
        windowSamples: Math.round(finite(merged.rules?.disk?.windowSamples, base.rules.disk.windowSamples, { min: 2, max: 24 })),
      },
      memory: {
        minAvailFraction: finite(merged.rules?.memory?.minAvailFraction, base.rules.memory.minAvailFraction, { min: 0, max: 1 }),
        minAvailBytes: finite(merged.rules?.memory?.minAvailBytes, base.rules.memory.minAvailBytes, { min: 0, max: 1e15 }),
      },
      load: { maxRatio: finite(merged.rules?.load?.maxRatio, base.rules.load.maxRatio, { min: 0.1, max: 100 }) },
      incident: {
        openAfter: Math.round(finite(merged.rules?.incident?.openAfter, base.rules.incident.openAfter, { min: 1, max: 10 })),
        closeAfter: Math.round(finite(merged.rules?.incident?.closeAfter, base.rules.incident.closeAfter, { min: 1, max: 10 })),
      },
    },
    notify: { enabled: merged.notify?.enabled === true },
    retention: {
      notifications: Math.round(finite(merged.retention?.notifications, base.retention.notifications, { min: 16, max: 10_000 })),
    },
  }

  if (config.ttlMs === base.ttlMs && merged.ttlMs !== base.ttlMs) diagnostics.push('ttlMs was invalid; using the default')
  if (config.rules.incident.openAfter === base.rules.incident.openAfter && merged.rules?.incident?.openAfter !== base.rules.incident.openAfter) {
    diagnostics.push('rules.incident.openAfter was invalid; using the default')
  }
  return { config, diagnostics }
}

/**
 * Read `config.json` from the state directory. A missing or malformed file is a
 * diagnostic, never an exception: the sampler must keep working with defaults.
 * @param {{stateDir: string, fs?: typeof fs}} options
 * @returns {{config: typeof DEFAULT_CONFIG, source: 'defaults' | 'file' | 'file-invalid', diagnostics: string[]}}
 */
export function loadConfigFile({ stateDir, fs: fileSystem = fs }) {
  const file = stateDir === undefined ? undefined : `${stateDir}/config.json`
  if (file === undefined) return { config: normalizeConfig({}).config, source: 'defaults', diagnostics: [] }
  const read = readJson(file, { fs: fileSystem })
  if (read.error !== null) {
    if (read.error.code === 'ENOENT') return { config: normalizeConfig({}).config, source: 'defaults', diagnostics: [] }
    const normalized = normalizeConfig({})
    return { config: normalized.config, source: 'file-invalid', diagnostics: [`${file}: ${read.error.message}; using defaults`] }
  }
  const normalized = normalizeConfig(read.value)
  return { config: normalized.config, source: 'file', diagnostics: normalized.diagnostics }
}

/**
 * Effective config for the Host tool: the file supplies sampling policy, the
 * row's `config` overrides read-side choices such as `ttlMs` and `enabled`.
 * @param {{rowConfig?: object, stateDir: string, fs?: typeof fs}} options
 */
export function resolveConfig({ rowConfig = {}, stateDir, fs: fileSystem = fs }) {
  const file = loadConfigFile({ stateDir, fs: fileSystem })
  const overrides = {}
  if (typeof rowConfig.ttlMs !== 'undefined') overrides.ttlMs = rowConfig.ttlMs
  if (typeof rowConfig.notify !== 'undefined') overrides.notify = rowConfig.notify
  if (typeof rowConfig.collectorTimeoutMs !== 'undefined') overrides.collectorTimeoutMs = rowConfig.collectorTimeoutMs
  const normalized = normalizeConfig(mergeConfig(file.config, overrides))
  return {
    config: normalized.config,
    source: file.source,
    diagnostics: [...file.diagnostics, ...normalized.diagnostics],
  }
}
