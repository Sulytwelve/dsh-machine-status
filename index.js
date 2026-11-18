/**
 * `machine-status` — the read-only Host row.
 *
 * Registers one model-facing tool that reads the snapshot written by the
 * independent systemd sampler. This row never samples, never spawns a process,
 * never writes machine state and never asks for approval. Its only side effect
 * is a small heartbeat file used to verify installation.
 */

import path from 'node:path'
import { resolveConfig } from './lib/config.mjs'
import { defaultStateDir, statePaths } from './lib/paths.mjs'
import { readStatus } from './lib/status-read.mjs'
import { renderEvidence, renderSources, renderStatus } from './lib/summary.mjs'
import { writeJsonAtomic } from './lib/write.mjs'
import { ownVersion } from './lib/version.mjs'
import { SCHEMA } from './lib/schema.mjs'

export const name = 'machine-status'

/** The tool registry is required; there is no storage or subprocess dependency. */
export const inject = ['tools']

const DESCRIPTION = 'Read the host\'s last sampled health: disk, memory and load, systemd services, '
  + 'backup freshness and IPv6. Read-only and cheap: it never samples, executes remediation, or asks for '
  + 'approval; a sample is reused from a local file until the freshness TTL expires. Use it when the user '
  + 'asks whether the machine is healthy or what changed. op=status returns the compact summary with '
  + 'evidence ids; op=evidence with one id returns that observation; op=sources explains paths, freshness '
  + 'and sampler state.'

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: {
      type: 'string',
      description: 'status (default) for the compact summary, evidence for one drill-down id, sources for paths and sampler diagnostics.',
      enum: ['status', 'evidence', 'sources'],
    },
    id: {
      type: 'string',
      description: 'An evidence id printed by op=status, for example svc:dsh-web or backup:forgejo-backup.service.',
    },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
  required: ['ok', 'text'],
}

function toolFor(ctx, { stateDir, resolved }) {
  const { config } = resolved
  return {
    name: 'machine_status',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args = {}) {
      try {
        const op = typeof args?.op === 'string' && args.op !== '' ? args.op : 'status'
        const read = readStatus({ stateDir, ttlMs: config.ttlMs })
        const effective = {
          ...config,
          diagnostics: [...(resolved.diagnostics ?? []), ...(read.diagnostics ?? [])],
        }
        if (op === 'status') {
          return {
            ok: true,
            text: renderStatus({
              snapshot: read.snapshot,
              status: read.status,
              freshness: read.freshness,
              config: effective,
              nowMs: Date.now(),
            }),
          }
        }
        if (op === 'evidence') {
          if (typeof args?.id !== 'string' || args.id === '') {
            return { ok: false, text: 'machine_status evidence: pass the id printed in the status evidence list, for example id="svc:dsh-web".' }
          }
          if (read.snapshot === null) {
            return { ok: false, text: 'machine_status evidence: no snapshot has been collected yet; run `dsh-machine-status doctor` on the host.' }
          }
          return renderEvidence({ snapshot: read.snapshot, id: args.id })
        }
        if (op === 'sources') {
          return {
            ok: true,
            text: renderSources({
              read,
              source: resolved.source,
              config: effective,
              nowMs: Date.now(),
            }),
          }
        }
        return { ok: false, text: `machine_status: unknown op "${op}"; use status, evidence or sources.` }
      } catch (error) {
        return {
          ok: false,
          text: `machine_status failed: ${error?.message ?? String(error)}. Run \`dsh-machine-status doctor\` on the host.`,
        }
      }
    },
  }
}

/**
 * Verify from inside the running Host process that the registry projects this
 * tool into the model-facing schema list. This is what makes the heartbeat a
 * load check rather than a self-report.
 */
function writeHeartbeat(ctx, { stateDir, resolved }) {
  try {
    let schemaNames = []
    let modelFacing = false
    try {
      const schemas = ctx.tools?.schemas?.() ?? []
      schemaNames = schemas.map(schema => schema.name).filter(named => typeof named === 'string')
      modelFacing = schemaNames.includes('machine_status')
    } catch {
      modelFacing = false
    }
    writeJsonAtomic(statePaths(stateDir).loaded, {
      schema: SCHEMA.loaded,
      kind: 'host-plugin',
      plugin: 'machine-status',
      version: ownVersion(),
      node: process.version,
      pid: process.pid,
      loadedAtMs: Date.now(),
      loadedAt: new Date().toISOString(),
      stateDir,
      ttlMs: resolved.config.ttlMs,
      tool: {
        name: 'machine_status',
        registered: true,
        modelFacing,
        schemaNames: schemaNames.slice(0, 40),
      },
    })
  } catch {
    // A diagnostic file that cannot be written must not block the row.
  }
}

/**
 * @param {object} ctx Cordis context with the required `tools` service.
 * @param {object} config the row's config.
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  const stateDir = typeof config?.stateDir === 'string' && config.stateDir.trim() !== ''
    ? path.resolve(config.stateDir.trim())
    : defaultStateDir()
  const resolved = resolveConfig({ rowConfig: config, stateDir })
  ctx.effect(() => ctx.tools.register(toolFor(ctx, { stateDir, resolved })))
  ctx.effect(() => {
    writeHeartbeat(ctx, { stateDir, resolved })
    return () => {}
  })
}
