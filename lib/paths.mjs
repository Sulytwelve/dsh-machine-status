/** One home for every path this plugin owns. Nothing here points at another plugin's data. */

import os from 'node:os'
import path from 'node:path'

/**
 * Resolve the state directory without touching the filesystem.
 *
 * Priority: explicit environment override, then the platform convention. On
 * Linux this follows XDG_STATE_HOME, which is `~/.local/state` by default; the
 * DSH service runs as the `dsh` user, so this lands beside the profile rather
 * than inside it.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function defaultStateDir(env = process.env, platform = process.platform) {
  if (typeof env.DSH_MACHINE_STATUS_STATE_DIR === 'string' && env.DSH_MACHINE_STATUS_STATE_DIR.trim() !== '') {
    return path.resolve(env.DSH_MACHINE_STATUS_STATE_DIR.trim())
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-machine-status')
  }
  if (typeof env.XDG_STATE_HOME === 'string' && env.XDG_STATE_HOME.trim() !== '') {
    return path.join(path.resolve(env.XDG_STATE_HOME.trim()), 'dsh-machine-status')
  }
  return path.join(os.homedir(), '.local', 'state', 'dsh-machine-status')
}

/**
 * Every file this plugin reads or writes, under one directory.
 * @param {string} stateDir
 */
export function statePaths(stateDir) {
  return {
    dir: stateDir,
    config: path.join(stateDir, 'config.json'),
    snapshot: path.join(stateDir, 'snapshot.json'),
    snapshot1: path.join(stateDir, 'snapshot-1.json'),
    snapshot2: path.join(stateDir, 'snapshot-2.json'),
    status: path.join(stateDir, 'status.json'),
    state: path.join(stateDir, 'state.json'),
    notifications: path.join(stateDir, 'notifications.jsonl'),
    loaded: path.join(stateDir, 'plugin-loaded.json'),
    lastError: path.join(stateDir, 'last-error.json'),
  }
}
