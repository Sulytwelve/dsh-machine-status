/** Read-only JSON and JSON Lines helpers that never throw on a missing or damaged file. */

import fs from 'node:fs'

/**
 * Read and parse one JSON file.
 * @param {string} file
 * @param {{fs?: typeof fs}} options
 * @returns {{value: unknown | null, mtimeMs: number | null, bytes: number | null, error: {code: string, message: string} | null}}
 */
export function readJson(file, { fs: fileSystem = fs } = {}) {
  try {
    const stat = fileSystem.statSync(file)
    const text = fileSystem.readFileSync(file, 'utf8')
    return { value: JSON.parse(text), mtimeMs: stat.mtimeMs, bytes: stat.size, error: null }
  } catch (error) {
    return {
      value: null,
      mtimeMs: null,
      bytes: null,
      error: { code: typeof error?.code === 'string' ? error.code : 'ERR_READ', message: error?.message ?? String(error) },
    }
  }
}

/**
 * Read one text file.
 * @param {string} file
 * @param {{fs?: typeof fs}} options
 */
export function readText(file, { fs: fileSystem = fs } = {}) {
  try {
    return { text: fileSystem.readFileSync(file, 'utf8'), error: null }
  } catch (error) {
    return { text: null, error: { code: typeof error?.code === 'string' ? error.code : 'ERR_READ', message: error?.message ?? String(error) } }
  }
}

/**
 * Read a JSON Lines file, skipping malformed rows and reporting how many were
 * skipped. A malformed trailing row (an interrupted append) is counted as
 * damaged but never hides earlier rows.
 * @param {string} file
 * @param {{fs?: typeof fs, limit?: number}} options
 * @returns {{rows: unknown[], damaged: number, error: {code: string, message: string} | null}}
 */
export function readJsonl(file, { fs: fileSystem = fs, limit = Number.POSITIVE_INFINITY } = {}) {
  const { text, error } = readText(file, { fs: fileSystem })
  if (error !== null) return { rows: [], damaged: 0, error }
  const rows = []
  let damaged = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      damaged += 1
    }
  }
  const bounded = Number.isFinite(limit) ? rows.slice(-limit) : rows
  return { rows: bounded, damaged, error: null }
}
