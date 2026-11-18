/** Read side shared by the Host tool and the CLI. Never writes, never samples. */

import fs from 'node:fs'
import { readJson } from './read.mjs'
import { statePaths } from './paths.mjs'

function ageOf(nowMs, observedAtMs) {
  return Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : null
}

/**
 * Load every document a reader needs and describe staleness.
 *
 * Freshness is computed from the snapshot's own completion time, so a process
 * restart or a stale cache cannot make an old sample look current.
 * @param {{stateDir: string, ttlMs: number, nowMs?: number, fs?: typeof fs}} options
 */
export function readStatus({ stateDir, ttlMs, nowMs = Date.now(), fs: fileSystem = fs }) {
  const paths = statePaths(stateDir)
  const snapshotRead = readJson(paths.snapshot, { fs: fileSystem })
  const statusRead = readJson(paths.status, { fs: fileSystem })
  const stateRead = readJson(paths.state, { fs: fileSystem })
  const loadedRead = readJson(paths.loaded, { fs: fileSystem })
  const diagnostics = []

  for (const [name, read] of [['snapshot', snapshotRead], ['status', statusRead], ['state', stateRead]]) {
    if (read.error !== null && read.error.code !== 'ENOENT') diagnostics.push(`${name}.json: ${read.error.message}`)
  }
  if (loadedRead.error !== null && loadedRead.error.code !== 'ENOENT') diagnostics.push(`plugin-loaded.json: ${loadedRead.error.message}`)

  const snapshot = snapshotRead.value
  const status = statusRead.value
  const state = stateRead.value

  let freshness
  if (snapshot === null) {
    freshness = { state: 'missing', ageMs: null, ttlMs, observedAtMs: null }
    diagnostics.push(`no snapshot at ${paths.snapshot}`)
  } else {
    const observedAtMs = Number.isFinite(snapshot.completedAtMs) ? snapshot.completedAtMs : null
    const ageMs = ageOf(nowMs, observedAtMs)
    const stale = ageMs === null || ageMs > ttlMs
    freshness = { state: stale ? 'stale' : 'fresh', ageMs, ttlMs, observedAtMs }
    if (stale) diagnostics.push(`snapshot is ${ageMs === null ? 'undated' : `${Math.round(ageMs / 1000)}s old`}; the freshness TTL is ${Math.round(ttlMs / 1000)}s`)
  }

  if (snapshot !== null && status !== null && status.sampleId !== snapshot.sampleId) {
    diagnostics.push('status.json belongs to a different sample id than snapshot.json; the sampler may have failed between writes')
  }

  return {
    paths,
    snapshot,
    status,
    state,
    loaded: loadedRead.value,
    freshness,
    diagnostics,
    mtimes: {
      snapshot: snapshotRead.mtimeMs,
      status: statusRead.mtimeMs,
      state: stateRead.mtimeMs,
      loaded: loadedRead.mtimeMs,
    },
    sizes: {
      snapshot: snapshotRead.bytes,
      status: statusRead.bytes,
      state: stateRead.bytes,
    },
  }
}
