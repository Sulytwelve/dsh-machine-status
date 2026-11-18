import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../lib/evaluate.mjs'
import { emptyState } from '../lib/state.mjs'
import { config, healthySnapshot, withSnapshot, writeFixtureState, NOW } from './support/fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'bin', 'cli.mjs')

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-cli-'))
}

function run(args, stateDir, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DSH_MACHINE_STATUS_STATE_DIR: stateDir, ...extraEnv },
  })
}

function freshDir() {
  const stateDir = temp()
  const now = Date.now()
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: now, nowMs: now }) })
  return stateDir
}

test('status: healthy sample exits 0 and prints the compact summary', () => {
  const stateDir = freshDir()
  const result = run(['status'], stateDir)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /machine_status: HEALTHY/)
  assert.match(result.stdout, /evidence /)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('status --json exposes freshness and the sample id', () => {
  const stateDir = freshDir()
  const result = run(['status', '--json'], stateDir)
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.freshness.state, 'fresh')
  assert.equal(parsed.status.overall, 'healthy')
  assert.equal(parsed.snapshot.sampleId, 'sample-1')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a stale sample exits 2 and names the last known verdict', () => {
  const stateDir = temp()
  const now = Date.now()
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: now - 10 * 60_000, nowMs: now - 10 * 60_000 }) })
  const result = run(['status'], stateDir)
  assert.equal(result.status, 2)
  assert.match(result.stdout, /machine_status: STALE/)
  assert.match(result.stdout, /last known: HEALTHY/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a missing snapshot exits 3', () => {
  const stateDir = path.join(temp(), 'missing')
  const result = run(['status'], stateDir)
  assert.equal(result.status, 3)
  assert.match(result.stdout, /machine_status: MISSING/)
})

test('evidence drills into one id, and an unknown id fails', () => {
  const stateDir = freshDir()
  const found = run(['evidence', 'svc:dsh-web'], stateDir)
  assert.equal(found.status, 0)
  assert.match(found.stdout, /systemctl show dsh-web\.service/)
  const missing = run(['evidence', 'nope'], stateDir)
  assert.equal(missing.status, 1)
  assert.match(missing.stdout, /unknown id/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('sources explains paths and freshness', () => {
  const stateDir = freshDir()
  const result = run(['sources'], stateDir)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /machine_status sources \(read-only\)/)
  assert.match(result.stdout, /snapshot .*fresh/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('export includes observation time and an advisory expiry', () => {
  const stateDir = temp()
  const now = Date.now()
  const snapshot = withSnapshot(healthySnapshot({ completedAtMs: now, nowMs: now }), next => {
    next.collectors.services.units[0].activeState = 'failed'
    next.collectors.services.units[0].result = 'exit-code'
  })
  const status = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: snapshot.completedAtMs }).status
  writeFixtureState(stateDir, { snapshot, status })
  const result = run(['export', '--finding', 'svc.unhealthy', '--json'], stateDir)
  assert.equal(result.status, 0)
  const parsed = JSON.parse(result.stdout)
  assert.ok(parsed.findings.some(finding => finding.subject === 'dsh-web'))
  assert.ok(parsed.findings.every(finding => finding.ruleId === 'svc.unhealthy'))
  assert.ok(parsed.expiresAtMs > parsed.observedAtMs)
  assert.match(parsed.note, /must enforce/)
  const absent = run(['export', '--finding', 'no.such.rule', '--json'], stateDir)
  assert.equal(absent.status, 1)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('doctor reports failures without a state directory', () => {
  const stateDir = path.join(temp(), 'missing')
  const result = run(['doctor'], stateDir)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /\[fail\] snapshot/)
})

test('install --dry-run changes nothing', () => {
  const stateDir = path.join(temp(), 'new-state')
  const result = run(['install', '--dry-run'], stateDir)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /would create state directory/)
  assert.equal(fs.existsSync(stateDir), false)
})

test('notifications on an empty store is an empty answer, not an error', () => {
  const stateDir = temp()
  const result = run(['notifications'], stateDir)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /no notifications/)
})

test('version prints the package version', () => {
  const result = run(['version'], temp())
  assert.equal(result.status, 0)
  assert.match(result.stdout, /dsh-machine-status 0\.1\.3/)
})
