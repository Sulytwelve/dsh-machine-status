import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../lib/evaluate.mjs'
import { emptyState } from '../lib/state.mjs'
import { renderStatus } from '../lib/summary.mjs'
import { readStatus } from '../lib/status-read.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config, healthySnapshot, withSnapshot, writeFixtureState, NOW } from './support/fixtures.mjs'

test('a failed collector yields unknown findings, a degraded sample and no invented value', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.memory = { status: 'failed', sampledAtMs: NOW, durationMs: 4, error: 'ENOENT /proc/meminfo' }
  })
  const evaluated = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  assert.notEqual(evaluated.status.overall, 'healthy')
  const failed = evaluated.status.findings.find(item => item.ruleId === 'collector.failed' && item.subject === 'memory')
  assert.equal(failed.severity, 'warning')
  const unknown = evaluated.status.findings.find(item => item.ruleId === 'mem.available.low')
  assert.equal(unknown.outcome, 'unknown')
  assert.equal(unknown.severity, 'warning')
  assert.ok(evaluated.status.counters.unknown > 0)
})

test('a fresh snapshot with one failed collector still reports the healthy fields', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-partial-'))
  const snapshot = withSnapshot(healthySnapshot({ completedAtMs: NOW, nowMs: NOW }), next => {
    next.collectors.memory = { status: 'failed', sampledAtMs: NOW, durationMs: 4, error: 'ENOENT /proc/meminfo', lastKnown: { atMs: NOW - 60_000, value: { availableBytes: 2_600_000_000, totalBytes: 4_000_000_000 } } }
  })
  writeFixtureState(stateDir, { snapshot })
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  const rendered = renderStatus({ snapshot: read.snapshot, status: read.status, freshness: read.freshness, config: config(), nowMs: NOW })
  assert.match(rendered, /disk     \/ 10\.0% used/)
  assert.match(rendered, /memory   unknown \(ENOENT \/proc\/meminfo\)/)
  assert.match(rendered, /diagnostic: memory unknown/)
  assert.doesNotMatch(rendered, /memory   .*available/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})
