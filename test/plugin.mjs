import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { statePaths } from '../lib/paths.mjs'
import { readJson } from '../lib/read.mjs'
import { writeFixtureState, healthySnapshot } from './support/fixtures.mjs'

function fakeCtx() {
  const definitions = []
  return {
    definitions,
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
      schemas() {
        return definitions.map(({ name, description, parameters }) => ({ name, description, parameters }))
      },
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
}

function freshStateDir() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-plugin-'))
  const now = Date.now()
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: now, nowMs: now }) })
  return stateDir
}

test('apply registers one read-only tool with the expected contract', () => {
  const stateDir = freshStateDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir })
  assert.equal(ctx.definitions.length, 1)
  const tool = ctx.definitions[0]
  assert.equal(tool.name, 'machine_status')
  assert.deepEqual(tool.parameters.properties.op.enum, ['status', 'evidence', 'sources'])
  assert.deepEqual(tool.output.schema.required, ['ok', 'text'])
  assert.deepEqual(tool.output.render({}, { text: 'hello' }), [{ type: 'text', text: 'hello' }])
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('the heartbeat records that the registry projects the tool into the model-facing schemas', () => {
  const stateDir = freshStateDir()
  apply(fakeCtx(), { stateDir })
  const heartbeat = readJson(statePaths(stateDir).loaded).value
  assert.equal(heartbeat.schema, 'dsh.machine-status/plugin-loaded@1')
  assert.equal(heartbeat.version, '0.1.1')
  assert.equal(heartbeat.tool.registered, true)
  assert.equal(heartbeat.tool.modelFacing, true)
  assert.ok(heartbeat.tool.schemaNames.includes('machine_status'))
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('execute returns the summary, evidence and sources; it never throws', async () => {
  const stateDir = freshStateDir()
  const ctx = fakeCtx()
  apply(ctx, { stateDir })
  const tool = ctx.definitions[0]

  const status = await tool.execute({ op: 'status' }, {})
  assert.equal(status.ok, true)
  assert.match(status.text, /machine_status: HEALTHY/)

  const evidence = await tool.execute({ op: 'evidence', id: 'svc:dsh-web' }, {})
  assert.equal(evidence.ok, true)
  assert.match(evidence.text, /svc:dsh-web/)

  const sources = await tool.execute({ op: 'sources' }, {})
  assert.equal(sources.ok, true)
  assert.match(sources.text, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const unknown = await tool.execute({ op: 'bogus' }, {})
  assert.equal(unknown.ok, false)

  const noId = await tool.execute({ op: 'evidence' }, {})
  assert.equal(noId.ok, false)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('a missing state directory is a diagnostic answer, not an exception', async () => {
  const stateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-plugin-missing-')), 'absent')
  const ctx = fakeCtx()
  apply(ctx, { stateDir })
  const result = await ctx.definitions[0].execute({ op: 'status' }, {})
  assert.equal(result.ok, true)
  assert.match(result.text, /machine_status: MISSING/)
})

test('a corrupt snapshot degrades to MISSING with a diagnostic', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-plugin-corrupt-'))
  fs.writeFileSync(statePaths(stateDir).snapshot, '{not json')
  const ctx = fakeCtx()
  apply(ctx, { stateDir })
  const result = await ctx.definitions[0].execute({ op: 'status' }, {})
  assert.equal(result.ok, true)
  assert.match(result.text, /machine_status: MISSING/)
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('enabled:false registers nothing', () => {
  const ctx = fakeCtx()
  apply(ctx, { enabled: false, stateDir: freshStateDir() })
  assert.equal(ctx.definitions.length, 0)
})
