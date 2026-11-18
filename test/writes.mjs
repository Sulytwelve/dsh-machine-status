import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendJsonl, writeJsonAtomic } from '../lib/write.mjs'
import { readJson, readJsonl } from '../lib/read.mjs'
import { runSample } from '../lib/sampler.mjs'
import { statePaths } from '../lib/paths.mjs'
import { config, fixtureCommands, NOW, healthySnapshot } from './support/fixtures.mjs'
import { failingWriteFs, fakeProcFs } from './support/fs.mjs'

test('atomic JSON write leaves a complete file and no temporary sibling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-write-'))
  const file = path.join(dir, 'value.json')
  writeJsonAtomic(file, { answer: 42 })
  assert.deepEqual(readJson(file).value, { answer: 42 })
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.includes('.tmp-')), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed write keeps the previous complete file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-write-fail-'))
  const file = path.join(dir, 'value.json')
  writeJsonAtomic(file, { answer: 41 })
  assert.throws(() => writeJsonAtomic(file, { answer: 42 }, { fs: failingWriteFs('ENOSPC') }), /ENOSPC/)
  assert.deepEqual(readJson(file).value, { answer: 41 })
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readJsonl skips a damaged row and reports the count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-jsonl-'))
  const file = path.join(dir, 'rows.jsonl')
  fs.writeFileSync(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n{"n":\n`)
  const read = readJsonl(file)
  assert.deepEqual(read.rows, [{ n: 1 }, { n: 2 }])
  assert.equal(read.damaged, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('appendJsonl keeps only the newest rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-jsonl-trim-'))
  const file = path.join(dir, 'rows.jsonl')
  for (const n of [1, 2, 3, 4, 5]) appendJsonl(file, [{ n }], { maxRows: 3 })
  assert.deepEqual(readJsonl(file).rows, [{ n: 3 }, { n: 4 }, { n: 5 }])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a failed snapshot write keeps the previous sample readable', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sampler-fail-'))
  const deps = { fs: fakeProcFs(), runner: fixtureCommands() }
  const first = runSample({ stateDir, config: config(), deps: { ...deps, sampleId: 'sample-1' }, nowMs: NOW })
  assert.equal(first.snapshot.sampleId, 'sample-1')

  assert.throws(
    () => runSample({ stateDir, config: config(), deps: { fs: failingWriteFs('ENOSPC'), runner: fixtureCommands(), sampleId: 'sample-2' }, nowMs: NOW + 60_000 }),
    /ENOSPC/,
  )

  const paths = statePaths(stateDir)
  const kept = readJson(paths.snapshot).value
  assert.equal(kept.sampleId, 'sample-1', 'the previous complete snapshot survives')
  assert.equal(readJson(paths.snapshot1).value.sampleId, 'sample-1')
  assert.equal(readJson(paths.status).value.sampleId, 'sample-1')
  fs.rmSync(stateDir, { recursive: true, force: true })
})

test('the fixture snapshot itself is internally consistent', () => {
  const snapshot = healthySnapshot()
  assert.equal(snapshot.schema, 'dsh.machine-status/snapshot@1')
  assert.equal(snapshot.collectors.services.units.length, 3)
})
