import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { statePaths } from '../lib/paths.mjs'
import { healthySnapshot, writeFixtureState } from './support/fixtures.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const cli = path.join(root, 'bin', 'cli.mjs')

test('the Host tool carries no execution or sampler dependency', () => {
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  assert.doesNotMatch(index, /child_process/)
  assert.doesNotMatch(index, /sampler\.mjs/)
  assert.doesNotMatch(index, /runSample/)
  const read = fs.readFileSync(path.join(root, 'lib', 'status-read.mjs'), 'utf8')
  assert.doesNotMatch(read, /runSample|from '\.\/sampler\.mjs'/)
})

test('the CLI status path never calls the sampler', () => {
  const source = fs.readFileSync(cli, 'utf8')
  const start = source.indexOf('function cmdStatus(')
  const end = source.indexOf('function cmdEvidence(')
  assert.ok(start > 0 && end > start)
  assert.doesNotMatch(source.slice(start, end), /runSample|sampler/)
})

test('repeated status calls leave every document byte-identical', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-nosample-'))
  const now = Date.now()
  writeFixtureState(stateDir, { snapshot: healthySnapshot({ completedAtMs: now, nowMs: now }) })
  const paths = statePaths(stateDir)
  const beforeList = fs.readdirSync(stateDir).sort()
  const beforeSnapshot = fs.readFileSync(paths.snapshot, 'utf8')
  const beforeMtime = fs.statSync(paths.snapshot).mtimeMs
  for (let index = 0; index < 3; index += 1) {
    const result = spawnSync(process.execPath, [cli, 'status'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DSH_MACHINE_STATUS_STATE_DIR: stateDir },
    })
    assert.equal(result.status, 0)
  }
  assert.equal(fs.readFileSync(paths.snapshot, 'utf8'), beforeSnapshot)
  assert.equal(fs.statSync(paths.snapshot).mtimeMs, beforeMtime)
  assert.deepEqual(fs.readdirSync(stateDir).sort(), beforeList)
  fs.rmSync(stateDir, { recursive: true, force: true })
})
