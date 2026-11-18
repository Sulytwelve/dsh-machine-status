/** Filesystem wrappers for deterministic collector and write-failure tests. */

import fs from 'node:fs'
import { fixtureProcFiles, fixtureStatfs } from './fixtures.mjs'

/**
 * Real filesystem with virtual `/proc` files and `statfs` results. Writes still
 * go to the real temp directory, so the test asserts real documents.
 * @param {{files?: Record<string,string>, statfs?: (mount: string) => object | undefined, bootId?: string}} options
 */
export function fakeProcFs({ files = {}, statfs = fixtureStatfs, bootId = 'boot-1' } = {}) {
  const virtual = { ...fixtureProcFiles({ bootId }), ...files }
  const wrapper = Object.create(fs)
  wrapper.readFileSync = (file, ...rest) => (Object.hasOwn(virtual, file) ? virtual[file] : fs.readFileSync(file, ...rest))
  wrapper.statfsSync = (mount, ...rest) => {
    const value = statfs(mount)
    return value !== undefined ? value : fs.statfsSync(mount, ...rest)
  }
  return wrapper
}

/**
 * A filesystem whose `writeFileSync` always fails with the given code, so a
 * failed snapshot write must leave the previous complete file untouched.
 * @param {string} code
 */
export function failingWriteFs(code = 'ENOSPC') {
  const wrapper = Object.create(fs)
  wrapper.writeFileSync = () => {
    const error = new Error(`simulated ${code}`)
    error.code = code
    throw error
  }
  return wrapper
}
