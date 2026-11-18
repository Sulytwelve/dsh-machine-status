import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runSample } from '../lib/sampler.mjs'
import { readJson } from '../lib/read.mjs'
import { readJsonl } from '../lib/read.mjs'
import { statePaths } from '../lib/paths.mjs'
import { config, fixtureCommands, NOW } from './support/fixtures.mjs'
import { fakeProcFs } from './support/fs.mjs'

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sampler-'))
}

function deps({ bootId = 'boot-1', runner = fixtureCommands(), sampleId = 'sample-1' } = {}) {
  return { fs: fakeProcFs({ bootId }), runner, sampleId }
}

test('one cycle writes snapshot, state and status with real evidence ids', () => {
  const stateDir = temp()
  const result = runSample({ stateDir, config: config(), deps: deps(), nowMs: NOW })
  assert.equal(result.snapshot.schema, 'dsh.machine-status/snapshot@1')
  assert.equal(result.snapshot.host.bootId, 'boot-1')
  assert.equal(result.snapshot.sampler.version, '0.1.2')
  for (const name of ['disk', 'memory', 'services', 'backup', 'ipv6']) {
    assert.equal(result.snapshot.collectors[name].status, 'ok', `${name} collector should be ok`)
    assert.ok(Number.isFinite(result.snapshot.collectors[name].durationMs))
  }
  assert.equal(result.snapshot.collectors.backup.ageMs, 4 * 3_600_000)
  assert.deepEqual(result.snapshot.collectors.ipv6.globalPrefixes, ['2408:825c:260:b0c::/64'])
  assert.equal(result.status.overall, 'healthy')
  assert.ok(result.snapshot.evidence['svc:dsh-web'])
  assert.ok(result.snapshot.evidence['backup:forgejo-backup.service'])

  const paths = statePaths(stateDir)
  assert.equal(readJson(paths.snapshot).value.sampleId, 'sample-1')
  assert.equal(readJson(paths.status).value.sampleId, 'sample-1')
  assert.ok(readJson(paths.state).value.lastGood.disk)
  assert.equal(fs.existsSync(paths.notifications), false, 'notifications stay off by default')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('two consecutive failed service samples open one incident and write one notification when enabled', () => {
  const stateDir = temp()
  const base = fixtureCommands()
  const inactive = (command, args) => {
    if (command === 'systemctl' && args.includes('dsh-web.service')) {
      return base(command, args).replace('ActiveState=active', 'ActiveState=failed').replace('Result=success', 'Result=exit-code')
    }
    return base(command, args)
  }
  const cfg = config({ notify: { enabled: true } })
  runSample({ stateDir, config: cfg, deps: deps({ runner: inactive, sampleId: 's1' }), nowMs: NOW })
  const second = runSample({ stateDir, config: cfg, deps: deps({ runner: inactive, sampleId: 's2' }), nowMs: NOW + 60_000 })
  assert.equal(second.status.incidents.length, 1)
  const rows = readJsonl(statePaths(stateDir).notifications).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].transition, 'opened')
  assert.equal(rows[0].ruleId, 'svc.unhealthy')

  runSample({ stateDir, config: cfg, deps: deps({ runner: inactive, sampleId: 's3' }), nowMs: NOW + 120_000 })
  assert.equal(readJsonl(statePaths(stateDir).notifications).rows.length, 1, 'an unchanged failure is not repeated')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a backup collector failure is contained: the snapshot is still written and the field is unknown', () => {
  const stateDir = temp()
  const base = fixtureCommands()
  const failingBackup = (command, args) => {
    if (command === 'systemctl' && args.includes('forgejo-backup.service')) {
      const error = new Error('systemctl timed out')
      error.code = 'ETIMEDOUT'
      throw error
    }
    return base(command, args)
  }
  const result = runSample({ stateDir, config: config(), deps: deps({ runner: failingBackup }), nowMs: NOW })
  assert.equal(result.snapshot.collectors.backup.status, 'failed')
  assert.match(result.snapshot.collectors.backup.error, /ETIMEDOUT/)
  assert.equal(result.snapshot.collectors.backup.lastKnown, null)
  assert.equal(result.status.overall, 'degraded')
  assert.equal(readJson(statePaths(stateDir).snapshot).value.collectors.backup.status, 'failed')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a changed boot id is reported and restarts state streaks', () => {
  const stateDir = temp()
  const first = runSample({ stateDir, config: config(), deps: deps({ bootId: 'boot-1' }), nowMs: NOW })
  assert.equal(first.state?.bootId ?? readJson(statePaths(stateDir).state).value.bootId, 'boot-1')
  const second = runSample({ stateDir, config: config(), deps: deps({ bootId: 'boot-2' }), nowMs: NOW + 60_000 })
  assert.equal(second.snapshot.host.bootId, 'boot-2')
  assert.equal(readJson(statePaths(stateDir).state).value.bootId, 'boot-2')
  const rebootFinding = second.status.findings.find(finding => finding.ruleId === 'host.reboot')
  assert.equal(rebootFinding.severity, 'info')
  fs.rmSync(stateDir, { recursive: true, force: true })
})
