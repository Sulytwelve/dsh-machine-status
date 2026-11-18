import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStatus } from '../lib/status-read.mjs'
import { renderStatus } from '../lib/summary.mjs'
import { config, healthySnapshot, writeFixtureState, NOW } from './support/fixtures.mjs'

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-stale-'))
}

function text(read, nowMs) {
  return renderStatus({
    snapshot: read.snapshot,
    status: read.status,
    freshness: read.freshness,
    config: { ...config(), diagnostics: read.diagnostics },
    nowMs,
  })
}

test('a missing snapshot is MISSING and names the state directory', () => {
  const stateDir = temp()
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.equal(read.freshness.state, 'missing')
  const rendered = text(read, NOW)
  assert.match(rendered, /machine_status: MISSING/)
  assert.ok(rendered.includes(stateDir), 'the diagnostic names the configured state directory')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a fresh sample reports age, observed time and the ttl', () => {
  const stateDir = temp()
  const completedAtMs = NOW - 42_000
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs, nowMs: completedAtMs }) })
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.equal(read.freshness.state, 'fresh')
  assert.equal(read.freshness.ageMs, 42_000)
  const rendered = text(read, NOW)
  assert.match(rendered, /machine_status: HEALTHY/)
  assert.match(rendered, /42s old \(ttl 180s\)/)
  assert.match(rendered, /evidence .*disk:\//)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('the freshness boundary is inclusive', () => {
  const stateDir = temp()
  const completedAtMs = NOW - 180_000
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs, nowMs: completedAtMs }) })
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.equal(read.freshness.state, 'fresh')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a stale sample keeps the last known verdict but refuses to be current', () => {
  const stateDir = temp()
  const completedAtMs = NOW - 448_000
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs, nowMs: completedAtMs }) })
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.equal(read.freshness.state, 'stale')
  const rendered = text(read, NOW)
  assert.match(rendered, /machine_status: STALE/)
  assert.match(rendered, /last known: HEALTHY/)
  assert.match(rendered, /reading never samples; this is not current machine state/)
})

test('a fresh snapshot without status.json is UNKNOWN, not healthy', () => {
  const stateDir = temp()
  const paths = writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: NOW, nowMs: NOW }) }).paths
  fs.rmSync(paths.status)
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.equal(read.freshness.state, 'fresh')
  assert.equal(read.status, null)
  const rendered = text(read, NOW)
  assert.match(rendered, /machine_status: UNKNOWN/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a status from a different sample id is a diagnostic', () => {
  const stateDir = temp()
  const paths = writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: NOW, nowMs: NOW }) }).paths
  const status = JSON.parse(fs.readFileSync(paths.status, 'utf8'))
  status.sampleId = 'other-sample'
  fs.writeFileSync(paths.status, JSON.stringify(status))
  const read = readStatus({ stateDir, ttlMs: 180_000, nowMs: NOW })
  assert.ok(read.diagnostics.some(line => line.includes('different sample id')))
  fs.rmSync(stateDir, { recursive: true, force: true })
})
