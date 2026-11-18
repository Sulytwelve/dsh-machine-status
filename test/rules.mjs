import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyState } from '../lib/state.mjs'
import { evaluate } from '../lib/evaluate.mjs'
import { config, evaluateSteps, healthySnapshot, withSnapshot, NOW } from './support/fixtures.mjs'

test('a fully readable sample is healthy; a declared-absent telemetry source is an expected unknown', () => {
  const result = evaluate({ snapshot: healthySnapshot(), state: emptyState(), config: config(), nowMs: NOW })
  assert.equal(result.status.overall, 'healthy')
  assert.equal(result.status.incidents.length, 0)
  assert.equal(result.status.findings.length, 0)
  assert.equal(result.status.unknowns.length, 1)
  assert.equal(result.status.unknowns[0].ruleId, 'svc.unhealthy')
  assert.equal(result.status.unknowns[0].subject, 'memory-probe')
  assert.equal(result.status.unknowns[0].expected, true)
  assert.match(result.status.unknowns[0].hint, /plugin-hosted service/)
})

test('an inactive systemd unit breaches svc.unhealthy at critical severity', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.services.units[0].activeState = 'failed'
    next.collectors.services.units[0].result = 'exit-code'
  })
  const result = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const finding = result.status.findings.find(item => item.ruleId === 'svc.unhealthy' && item.subject === 'dsh-web')
  assert.equal(finding.severity, 'critical')
  assert.equal(result.status.overall, 'degraded')
  assert.equal(result.status.incidents.length, 0, 'one breach does not open an incident yet')
})

test('disk free floor breaches disk.free.low and keeps the mount evidence id', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.disk.mounts[0].availBytes = 100 * 1024 * 1024
    next.collectors.disk.mounts[0].availFraction = 0.01
    next.collectors.disk.mounts[0].usedFraction = 0.99
  })
  const result = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const finding = result.status.findings.find(item => item.ruleId === 'disk.free.low')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.evidenceId, 'disk:/')
})

test('memory floor and load multiple are warnings', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.memory.availableBytes = 100 * 1024 * 1024
    next.collectors.memory.availFraction = 0.01
    next.collectors.memory.load1 = 20
  })
  const result = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const memory = result.status.findings.find(item => item.ruleId === 'mem.available.low')
  const load = result.status.findings.find(item => item.ruleId === 'load.high')
  assert.equal(memory.severity, 'warning')
  assert.equal(load.severity, 'warning')
})

test('a backup older than the policy limit is critical', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.backup.ageMs = 27 * 3_600_000
    next.collectors.backup.completedAtMs = NOW - 27 * 3_600_000
  })
  const result = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const finding = result.status.findings.find(item => item.ruleId === 'backup.stale')
  assert.equal(finding.severity, 'critical')
  assert.equal(finding.evidenceId, 'backup:forgejo-backup.service')
})

test('a routine prefix change is information only and never opens an incident', () => {
  const first = healthySnapshot({ nowMs: NOW, completedAtMs: NOW })
  const second = withSnapshot(healthySnapshot({ nowMs: NOW + 60_000, completedAtMs: NOW + 60_000 }), next => {
    next.collectors.ipv6.globalPrefixes = ['2408:825c:2ff:b0c::/64']
    next.sampleId = 'sample-2'
  })
  const { results } = evaluateSteps([{ snapshot: first }, { snapshot: second }])
  const finding = results[1].status.findings.find(item => item.ruleId === 'ipv6.prefix.changed')
  assert.equal(finding.severity, 'info')
  assert.equal(results[1].status.incidents.length, 0)
  assert.equal(results[1].transitions.length, 0)
})

test('a missing global address alerts only when the policy requires it', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.ipv6.addresses = []
    next.collectors.ipv6.globalPrefixes = []
  })
  const lenient = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const lenientFinding = lenient.status.findings.find(item => item.ruleId === 'ipv6.global.missing')
  assert.equal(lenientFinding.severity, 'info')

  const strict = evaluate({ snapshot, state: emptyState(), config: config({ collect: { ipv6: { requireGlobal: true } } }), nowMs: NOW })
  const strictFinding = strict.status.findings.find(item => item.ruleId === 'ipv6.global.missing')
  assert.equal(strictFinding.severity, 'warning')
  assert.equal(strictFinding.outcome, 'breach')
})

test('a failed collector separates actionable findings from unexpected unknowns', () => {
  const snapshot = withSnapshot(healthySnapshot(), next => {
    next.collectors.services = { status: 'failed', sampledAtMs: NOW, durationMs: 3, error: 'systemctl is unavailable' }
  })
  const result = evaluate({ snapshot, state: emptyState(), config: config(), nowMs: NOW })
  const failed = result.status.findings.find(item => item.ruleId === 'collector.failed')
  assert.equal(failed.severity, 'warning')
  const serviceUnknowns = result.status.unknowns.filter(item => item.ruleId === 'svc.unhealthy')
  assert.ok(serviceUnknowns.length >= 1)
  const systemdUnknown = serviceUnknowns.find(item => item.subject === 'dsh-web')
  assert.equal(systemdUnknown.severity, 'warning')
  assert.equal(systemdUnknown.expected, false)
  const declaredUnknown = serviceUnknowns.find(item => item.subject === 'memory-probe')
  assert.equal(declaredUnknown.expected, true)
  assert.equal(result.status.overall, 'degraded')
})
