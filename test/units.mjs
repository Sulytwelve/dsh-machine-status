import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UNIT_NAMES, serviceUnit, timerUnit } from '../lib/units.mjs'
import { installSampler, runtimePaths, uninstallSampler } from '../lib/install.mjs'

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ms-units-'))
}

function fakeSystemctl(calls) {
  return args => {
    calls.push(args.join(' '))
    return { ok: true, status: 0, stdout: '', stderr: '', error: null }
  }
}

test('the service unit runs the sampler as the user with hardening', () => {
  const unit = serviceUnit({ execPath: '/usr/bin/node', scriptPath: '/home/dsh/.local/lib/dsh-machine-status/bin/sampler.mjs', stateDir: '/home/dsh/.local/state/dsh-machine-status' })
  assert.equal(UNIT_NAMES.service, 'dsh-machine-status.service')
  assert.match(unit, /^\[Service\]$/m)
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/dsh\/\.local\/lib\/dsh-machine-status\/bin\/sampler\.mjs/)
  assert.match(unit, /Environment=DSH_MACHINE_STATUS_STATE_DIR=\/home\/dsh\/\.local\/state\/dsh-machine-status/)
  assert.match(unit, /NoNewPrivileges=yes/)
  assert.match(unit, /ProtectSystem=strict/)
  assert.match(unit, /ReadWritePaths=\/home\/dsh\/\.local\/state\/dsh-machine-status/)
  assert.doesNotMatch(unit, /User=/)
})

test('the timer samples on boot and every minute', () => {
  const unit = timerUnit({ cadenceSec: 60 })
  assert.match(unit, /OnBootSec=45s/)
  assert.match(unit, /OnUnitActiveSec=60s/)
  assert.match(unit, /WantedBy=timers\.target/)
})

test('install --dry-run reports actions without touching disk', () => {
  const homeDir = temp()
  const stateDir = path.join(homeDir, 'state')
  const result = installSampler({ stateDir, homeDir, dryRun: true, systemctl: fakeSystemctl([]) })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.ok(result.actions.some(action => action.includes('runtime copy')))
  assert.equal(fs.existsSync(stateDir), false)
  assert.equal(fs.existsSync(runtimePaths(homeDir).unitDir), false)
})

test('install writes config, runtime copy and user units; uninstall keeps state unless purged', () => {
  const homeDir = temp()
  const stateDir = path.join(homeDir, 'state')
  const calls = []
  const systemctl = fakeSystemctl(calls)

  const installed = installSampler({ stateDir, homeDir, execPath: '/usr/bin/node', systemctl })
  assert.equal(installed.ok, true, JSON.stringify(installed.diagnostics))
  assert.ok(fs.existsSync(path.join(stateDir, 'config.json')))
  const runtime = runtimePaths(homeDir)
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'bin', 'sampler.mjs')))
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'lib', 'sampler.mjs')))
  assert.ok(fs.existsSync(path.join(runtime.runtimeDir, 'VERSION')))
  assert.ok(fs.existsSync(runtime.serviceFile))
  assert.ok(fs.existsSync(runtime.timerFile))
  assert.ok(calls.includes('daemon-reload'))
  assert.ok(calls.some(call => call === 'enable --now dsh-machine-status.timer'))
  assert.ok(calls.some(call => call === 'start dsh-machine-status.service'))

  const removed = uninstallSampler({ stateDir, homeDir, systemctl })
  assert.equal(removed.ok, true)
  assert.equal(fs.existsSync(runtime.serviceFile), false)
  assert.equal(fs.existsSync(runtime.timerFile), false)
  assert.equal(fs.existsSync(runtime.runtimeDir), false)
  assert.equal(fs.existsSync(stateDir), true, 'state is kept for postmortem')

  const purged = uninstallSampler({ stateDir, homeDir, systemctl, purge: true })
  assert.equal(purged.ok, true)
  assert.equal(fs.existsSync(stateDir), false)
})
