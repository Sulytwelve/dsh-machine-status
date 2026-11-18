/** Atomic single-file writes and bounded append-only JSON Lines. */

import fs from 'node:fs'
import path from 'node:path'
import { readJsonl } from './read.mjs'

/**
 * Write JSON through a same-directory temporary file and rename, so a crash or
 * a full disk leaves the previous complete file in place. The temporary file is
 * removed on failure. The filesystem is injectable for failure tests.
 * @param {string} file
 * @param {unknown} value
 * @param {{fs?: typeof fs, mode?: number}} options
 */
export function writeJsonAtomic(file, value, { fs: fileSystem = fs, mode = 0o600 } = {}) {
  const directory = path.dirname(file)
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode })
    fileSystem.renameSync(temporary, file)
  } catch (error) {
    try { fileSystem.unlinkSync(temporary) } catch { /* the temporary may not exist */ }
    throw error
  }
}

/**
 * Append one row per line and trim the file to `maxRows` in the same call.
 * Trimming rewrites through a temporary file, so a reader never sees a partial
 * line; the injected filesystem drives the failure tests.
 * @param {string} file
 * @param {unknown[]} rows
 * @param {{fs?: typeof fs, maxRows?: number, mode?: number}} options
 */
export function appendJsonl(file, rows, { fs: fileSystem = fs, maxRows = 512, mode = 0o600 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { appended: 0, trimmed: 0 }
  const directory = path.dirname(file)
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fileSystem.appendFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, { mode })
  const read = readJsonl(file, { fs: fileSystem })
  if (read.error !== null) return { appended: rows.length, trimmed: 0 }
  if (read.rows.length <= maxRows) return { appended: rows.length, trimmed: 0 }
  const kept = read.rows.slice(-maxRows)
  const trimmed = read.rows.length - kept.length
  const temporary = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  fileSystem.writeFileSync(temporary, `${kept.map(row => JSON.stringify(row)).join('\n')}\n`, { mode })
  fileSystem.renameSync(temporary, file)
  return { appended: rows.length, trimmed }
}
