/**
 * User-level systemd units. The sampler runs as the same unprivileged user as
 * the DSH service, so installation needs no root and the timer survives logout
 * only when that user has lingering enabled (documented).
 */

export const UNIT_NAMES = Object.freeze({
  service: 'dsh-machine-status.service',
  timer: 'dsh-machine-status.timer',
})

/**
 * @param {{execPath: string, scriptPath: string, stateDir: string}} options
 * @returns {string}
 */
export function serviceUnit({ execPath, scriptPath, stateDir }) {
  return `[Unit]
Description=DSH machine status sampler (read-only)

[Service]
Type=oneshot
Environment=DSH_MACHINE_STATUS_STATE_DIR=${stateDir}
ExecStart=${execPath} ${scriptPath}
WorkingDirectory=%h
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${stateDir}
LockPersonality=yes
RestrictSUIDSGID=yes
`
}

/**
 * @param {{cadenceSec?: number}} options
 * @returns {string}
 */
export function timerUnit({ cadenceSec = 60 } = {}) {
  return `[Unit]
Description=Sample DSH machine status

[Timer]
OnBootSec=45s
OnUnitActiveSec=${cadenceSec}s
AccuracySec=5s
Unit=${UNIT_NAMES.service}

[Install]
WantedBy=timers.target
`
}
