import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../lib/evaluate.mjs'
import { emptyState } from '../lib/state.mjs'
import { config, healthySnapshot, withSnapshot, NOW } from './support/fixtures.mjs'

const cfg = config()

function inactive(nowMs, { sampleId = Math.random().toString(36).slice(2), bootId = 'boot-1' } = {}) {
  return withSnapshot(healthySnapshot({ nowMs, completedAtMs: nowMs, bootId, sampleId }), next => {
    next.collectors.services.units[0].activeState = 'failed'
    next.collectors.services.units[0].result = 'exit-code'
  })
}

function step(state, snapshot, overrides = {}) {
  return evaluate({ snapshot, state, config: cfg, nowMs: snapshot.completedAtMs, ...overrides })
}

test('two consecutive breaches open one incident and emit one transition', () => {
  const first = step(emptyState(), inactive(NOW))
  assert.equal(first.status.incidents.length, 0)
  assert.equal(first.transitions.length, 0)

  const second = step(first.state, inactive(NOW + 60_000))
  assert.equal(second.status.incidents.length, 1)
  assert.equal(second.transitions.length, 1)
  assert.equal(second.transitions[0].transition, 'opened')
  assert.equal(second.transitions[0].ruleId, 'svc.unhealthy')

  const third = step(second.state, inactive(NOW + 120_000))
  assert.equal(third.status.incidents.length, 1)
  assert.equal(third.transitions.length, 0, 'an unchanged failure is not repeated')
})

test('two healthy samples close the incident and emit one close transition', () => {
  let state = step(emptyState(), inactive(NOW)).state
  state = step(state, inactive(NOW + 60_000)).state
  const open = step(state, inactive(NOW + 120_000))
  assert.equal(open.status.incidents.length, 1)

  const recovering = step(open.state, healthySnapshot({ nowMs: NOW + 180_000, completedAtMs: NOW + 180_000, sampleId: 'healthy-1' }))
  assert.equal(recovering.status.incidents.length, 1, 'one healthy sample is not enough')
  assert.equal(recovering.transitions.length, 0)

  const closed = step(recovering.state, healthySnapshot({ nowMs: NOW + 240_000, completedAtMs: NOW + 240_000, sampleId: 'healthy-2' }))
  assert.equal(closed.status.incidents.length, 0)
  assert.equal(closed.transitions.length, 1)
  assert.equal(closed.transitions[0].transition, 'closed')
})

test('unknown telemetry neither closes an incident nor resets its streak', () => {
  let state = step(emptyState(), inactive(NOW)).state
  state = step(state, inactive(NOW + 60_000)).state
  assert.equal(Object.keys(state.incidents).length, 1)

  const broken = withSnapshot(healthySnapshot({ nowMs: NOW + 120_000, completedAtMs: NOW + 120_000, sampleId: 'broken' }), next => {
    next.collectors.services = { status: 'failed', sampledAtMs: NOW + 120_000, durationMs: 2, error: 'systemctl timed out' }
  })
  const gapped = step(state, broken)
  assert.equal(gapped.status.incidents.length, 1, 'loss of telemetry cannot close the incident')
  assert.equal(gapped.transitions.length, 0)
  const gapFinding = gapped.status.findings.find(item => item.ruleId === 'telemetry.gap')
  assert.equal(gapFinding.severity, 'warning')

  const nextBreach = step(gapped.state, inactive(NOW + 180_000))
  assert.equal(nextBreach.status.incidents.length, 1)
  assert.equal(nextBreach.transitions.length, 0, 'still the same incident')
})

test('a reboot restarts streaks and reports an informational finding', () => {
  const first = step(emptyState(), inactive(NOW))
  const rebooted = step(first.state, inactive(NOW + 60_000, { bootId: 'boot-2' }), { reboot: true })
  assert.equal(rebooted.status.incidents.length, 0, 'the pre-reboot breach streak does not carry over')
  const finding = rebooted.status.findings.find(item => item.ruleId === 'host.reboot')
  assert.equal(finding.severity, 'info')
  assert.equal(rebooted.status.overall, 'degraded', 'the current breach still degrades the sample')

  const secondBreach = step(rebooted.state, inactive(NOW + 120_000, { bootId: 'boot-2' }))
  assert.equal(secondBreach.status.incidents.length, 1)
})

test('information never opens an incident by itself', () => {
  let state = emptyState()
  for (const index of [0, 1, 2]) {
    const snapshot = withSnapshot(healthySnapshot({ nowMs: NOW + index * 60_000, completedAtMs: NOW + index * 60_000, sampleId: `p-${index}` }), next => {
      next.collectors.ipv6.globalPrefixes = [`2408:825c:${index}00:b0c::/64`]
    })
    const result = step(state, snapshot)
    state = result.state
    assert.equal(result.status.incidents.length, 0)
    assert.equal(result.transitions.length, 0)
  }
})
