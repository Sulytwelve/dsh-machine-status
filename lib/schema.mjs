/** Version strings for every file this plugin writes. Bump only on incompatible shape changes. */

export const SCHEMA = Object.freeze({
  snapshot: 'dsh.machine-status/snapshot@1',
  status: 'dsh.machine-status/status@1',
  state: 'dsh.machine-status/state@1',
  notification: 'dsh.machine-status/notification@1',
  loaded: 'dsh.machine-status/plugin-loaded@1',
})
