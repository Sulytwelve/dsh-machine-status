/**
 * One sampling cycle: collect, evaluate, then write the three documents in an
 * order that keeps a reader safe. The snapshot is written first and survives a
 * later failure; the status names the sample id it evaluated.
 *
 * This module is the single writer. The Host tool and the CLI never call it.
 */

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { appendJsonl, writeJsonAtomic } from './write.mjs'
import { readJson } from './read.mjs'
import { statePaths } from './paths.mjs'
import { normalizeState } from './state.mjs'
import { evaluate } from './evaluate.mjs'
import { SCHEMA } from './schema.mjs'
import { isoLocal } from './format.mjs'
import {
  collectBackup, collectDisk, collectHost, collectIpv6, collectMemory, collectServices, defaultRunner,
} from './collectors.mjs'
import { ownVersion } from './version.mjs'

const COLLECTORS = [
  ['disk', collectDisk],
  ['memory', collectMemory],
  ['services', collectServices],
  ['backup', collectBackup],
  ['ipv6', collectIpv6],
]

function compact(name, entry) {
  if (name === 'disk') {
    return { mounts: (entry.mounts ?? []).map(mount => ({ mount: mount.mount, availBytes: mount.availBytes, sizeBytes: mount.sizeBytes, error: mount.error })) }
  }
  if (name === 'memory') {
    return { availableBytes: entry.availableBytes, totalBytes: entry.totalBytes, load1: entry.load1, cpuCount: entry.cpuCount }
  }
  if (name === 'services') {
    return { units: (entry.units ?? []).map(unit => ({ id: unit.id, status: unit.status, activeState: unit.activeState, result: unit.result, error: unit.error })) }
  }
  if (name === 'backup') {
    return { lastResult: entry.lastResult, execMainStatus: entry.execMainStatus, ageMs: entry.ageMs, artifact: entry.artifact }
  }
  if (name === 'ipv6') {
    return { interface: entry.interface, globalPrefixes: entry.globalPrefixes }
  }
  return null
}

function buildEvidence(name, entry) {
  const evidence = {}
  if (name === 'disk') {
    for (const mount of entry.mounts ?? []) {
      evidence[`disk:${mount.mount}`] = { source: 'fs.statfs', sampledAtMs: entry.sampledAtMs, ...mount }
    }
  } else if (name === 'memory') {
    evidence.mem = {
      source: entry.source ?? '/proc/meminfo',
      sampledAtMs: entry.sampledAtMs,
      totalBytes: entry.totalBytes,
      availableBytes: entry.availableBytes,
      availFraction: entry.availFraction,
      swapTotalBytes: entry.swapTotalBytes,
      swapFreeBytes: entry.swapFreeBytes,
    }
    evidence.load = {
      source: '/proc/loadavg',
      sampledAtMs: entry.sampledAtMs,
      load1: entry.load1,
      load5: entry.load5,
      load15: entry.load15,
      cpuCount: entry.cpuCount,
    }
  } else if (name === 'services') {
    for (const unit of entry.units ?? []) {
      evidence[`svc:${unit.id}`] = {
        source: unit.unit === null ? 'none (plugin-hosted)' : `systemctl show ${unit.unit}`,
        sampledAtMs: entry.sampledAtMs,
        ...unit,
      }
    }
  } else if (name === 'backup') {
    evidence[`backup:${entry.job ?? 'backup'}`] = {
      source: 'systemctl show',
      sampledAtMs: entry.sampledAtMs,
      ...entry,
    }
  } else if (name === 'ipv6') {
    evidence[`ipv6:${entry.interface ?? 'ipv6'}`] = {
      source: 'ip -6 -j addr show dev',
      sampledAtMs: entry.sampledAtMs,
      ...entry,
    }
  }
  if (entry.status === 'failed') {
    evidence[`collector:${name}`] = { source: 'collector', sampledAtMs: entry.sampledAtMs, status: entry.status, error: entry.error }
  }
  return evidence
}

function rotateSnapshots(paths, fileSystem) {
  // Copy, never move: a failed write below must leave snapshot.json readable.
  for (const [from, to] of [[paths.snapshot1, paths.snapshot2], [paths.snapshot, paths.snapshot1]]) {
    try {
      fileSystem.copyFileSync(from, to)
    } catch {
      // Missing previous sample or a cross-device filesystem: the next write still lands.
    }
  }
}

/**
 * Run one sampling cycle and persist the documents.
 * @param {{
 *   stateDir: string,
 *   config: object,
 *   deps?: {fs?: typeof fs, runner?: Function, sampleId?: string},
 *   nowMs?: number,
 * }} options
 * @returns {{snapshot: object, status: object, transitions: object[], diagnostics: string[]}}
 */
export function runSample({ stateDir, config, deps = {}, nowMs = Date.now() }) {
  const fileSystem = deps.fs ?? fs
  const runner = deps.runner ?? defaultRunner
  const paths = statePaths(stateDir)
  const realStart = Date.now()
  const stored = normalizeState(readJson(paths.state, { fs: fileSystem }).value)
  const startedAtMs = nowMs
  const host = collectHost({ fs: fileSystem })
  const reboot = stored.bootId !== null && host.bootId !== null && stored.bootId !== host.bootId
  const collectors = {}
  const evidence = { host: { ...host, source: 'os.hostname + /proc' } }
  const diagnostics = []
  const lastGood = { ...stored.lastGood }

  for (const [name, collect] of COLLECTORS) {
    const collectorStart = Date.now()
    let entry
    try {
      entry = collect({ config, fs: fileSystem, runner, nowMs: startedAtMs, state: stored })
    } catch (error) {
      entry = { status: 'failed', sampledAtMs: startedAtMs, error: error?.message ?? String(error) }
    }
    entry = { ...entry, durationMs: Date.now() - collectorStart }
    if (entry.status !== 'ok') {
      entry.lastKnown = lastGood[name] ?? null
      diagnostics.push(`${name}: ${entry.error ?? entry.status}`)
    } else {
      lastGood[name] = { atMs: entry.sampledAtMs, value: compact(name, entry) }
    }
    collectors[name] = entry
    Object.assign(evidence, buildEvidence(name, entry))
  }

  const elapsedMs = Date.now() - realStart
  const completedAtMs = startedAtMs + elapsedMs
  const snapshot = {
    schema: SCHEMA.snapshot,
    sampleId: deps.sampleId ?? randomUUID(),
    sampler: {
      version: ownVersion(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    host,
    startedAtMs,
    startedAt: isoLocal(startedAtMs),
    completedAtMs,
    completedAt: isoLocal(completedAtMs),
    durationMs: elapsedMs,
    collectorTimeoutMs: config.collectorTimeoutMs,
    collectors,
    evidence,
    diagnostics,
  }

  const evaluated = evaluate({
    snapshot,
    state: stored,
    config,
    nowMs: completedAtMs,
    reboot,
  })

  const nextState = {
    ...evaluated.state,
    schema: SCHEMA.state,
    lastGood,
  }

  const status = evaluated.status

  try {
    rotateSnapshots(paths, fileSystem)
    writeJsonAtomic(paths.snapshot, snapshot, { fs: fileSystem })
    writeJsonAtomic(paths.state, nextState, { fs: fileSystem })
    writeJsonAtomic(paths.status, status, { fs: fileSystem })
    if (config.notify.enabled === true && evaluated.transitions.length > 0) {
      const rows = evaluated.transitions.map(transition => ({
        schema: SCHEMA.notification,
        atMs: transition.atMs,
        at: isoLocal(transition.atMs),
        incident: transition.key,
        ruleId: transition.ruleId,
        subject: transition.subject,
        severity: transition.severity,
        transition: transition.transition,
        evidenceId: transition.evidenceId,
        message: transition.message,
      }))
      appendJsonl(paths.notifications, rows, { fs: fileSystem, maxRows: config.retention.notifications })
    }
  } catch (error) {
    try {
      writeJsonAtomic(paths.lastError, {
        schema: SCHEMA.snapshot,
        atMs: Date.now(),
        at: isoLocal(Date.now()),
        message: error?.message ?? String(error),
        code: error?.code ?? null,
      }, { fs: fileSystem })
    } catch {
      // A dead collector cannot reliably write its own failure report; the stale snapshot is the fallback.
    }
    throw error
  }

  return { snapshot, status, transitions: evaluated.transitions, diagnostics }
}
