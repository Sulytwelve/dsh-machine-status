/** The running package version, read from its own manifest (also inside the installed runtime copy). */

import fs from 'node:fs'

let cached

/**
 * @returns {string}
 */
export function ownVersion() {
  if (cached !== undefined) return cached
  try {
    const url = new URL('../package.json', import.meta.url)
    cached = JSON.parse(fs.readFileSync(url, 'utf8')).version ?? '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
