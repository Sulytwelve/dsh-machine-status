#!/usr/bin/env node
/**
 * The sampler entry point run by the systemd timer. One cycle, then exit.
 * Silent on success (systemd journal stays quiet); one line on failure.
 */

import { defaultStateDir } from '../lib/paths.mjs'
import { loadConfigFile } from '../lib/config.mjs'
import { runSample } from '../lib/sampler.mjs'

const stateDir = process.env.DSH_MACHINE_STATUS_STATE_DIR !== undefined && process.env.DSH_MACHINE_STATUS_STATE_DIR !== ''
  ? process.env.DSH_MACHINE_STATUS_STATE_DIR
  : defaultStateDir()
const loaded = loadConfigFile({ stateDir })

try {
  const result = runSample({ stateDir, config: loaded.config })
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ stateDir, sampleId: result.snapshot.sampleId, overall: result.status.overall, transitions: result.transitions, diagnostics: result.diagnostics }, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`dsh-machine-status sampler: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
}
