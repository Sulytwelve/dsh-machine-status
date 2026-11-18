# Operations

## Sampling model

`dsh-machine-status install` writes a user-level oneshot service and timer:

- `dsh-machine-status.service`: `ExecStart=<node> %h/.local/lib/dsh-machine-status/bin/sampler.mjs`
- `dsh-machine-status.timer`: `OnBootSec=45s`, `OnUnitActiveSec=60s`, `AccuracySec=5s`

The service runs with `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`,
`ProtectHome=read-only` and `ReadWritePaths=<stateDir>`. The last line matters: without it the
strict filesystem view makes the state directory read-only and the sampler fails with `EROFS`.

The timer needs lingering for the DSH user to run without a login session:

```sh
loginctl show-user <user> -p Linger     # Linger=yes on the reference host
loginctl enable-linger <user>           # if it is not
```

## Paths and cleanup ownership

| Path | Owner | Removed by |
|---|---|---|
| `~/.local/state/dsh-machine-status/` | DSH user | `uninstall --purge` |
| `~/.local/lib/dsh-machine-status/` | DSH user | `uninstall` |
| `~/.config/systemd/user/dsh-machine-status.{service,timer}` | DSH user | `uninstall` |

No other path is touched. The context-manager's `~/.dsh/storages/agent_memory` is never read or
written by this plugin.

## Documents

| File | Meaning |
|---|---|
| `snapshot.json` | the last complete sample: host/boot id, timings, collectors, evidence map |
| `status.json` | the evaluated sample: overall, findings, open incidents, counters |
| `state.json` | streaks, incidents, last-known values, disk/IPv6 comparison history |
| `notifications.jsonl` | opt-in incident transitions, bounded |
| `plugin-loaded.json` | heartbeat written by the Host row: version, pid, `modelFacing` |
| `last-error.json` | best-effort note when a sampling cycle could not persist |

Writes are atomic (same-directory temp + rename). Snapshot rotation **copies** the previous file to
`snapshot-1.json`/`snapshot-2.json` before writing, so a failed write leaves the current snapshot
readable.

## Verify

```sh
dsh-machine-status status           # human summary; exit 2 if stale/degraded
dsh-machine-status doctor           # writability, documents, heartbeat, runtime version, timer
dsh-machine-status sources          # paths, mtimes, freshness, sampler state
dsh-machine-status sample --json    # force one cycle (what the timer does)
```

`doctor` is the first check after any Host restart: `[ok] host plugin … model-facing yes` means the
running process loaded the row and its registry projects the tool.

## Troubleshooting

| Symptom | Check |
|---|---|
| `machine_status: MISSING` | `dsh-machine-status doctor`; state directory exists? timer active? |
| `machine_status: STALE` | `systemctl --user status dsh-machine-status.service`, `journalctl --user -u dsh-machine-status.service` |
| service fails `EROFS` | the unit lacks `ReadWritePaths=<stateDir>`; rerun `install` after upgrading |
| service fails `ENOENT` | runtime copy missing; rerun `install` |
| timer inactive after logout | linger disabled for the DSH user |
| heartbeat says `model-facing: no` | the tool registry did not project the tool; check for a duplicate name or a failed row |
| `doctor` reports runtime version mismatch | package updated without `install`; rerun `install` and restart the DSH host process |

A dead sampler cannot report itself; the snapshot's age is the authoritative signal, and `doctor`
adds the timer's own state.

## Upgrade

```sh
# DSH has no in-place update: remove, add the new tag, then restart.
dsh plugin --profile web remove @sulytwelve/dsh-machine-status
dsh plugin --profile web add github:Sulytwelve/dsh-machine-status#v0.1.3
dsh-machine-status install          # refresh the runtime copy and units
# restart the DSH host process you run; DSH's CLI provides no unit or service manager.
```

The installed runtime copy is version-stamped; `doctor` compares it with the package version.

## Rollback

```sh
dsh-machine-status uninstall            # stop timer, remove units, keep state
dsh-machine-status uninstall --purge    # also remove the state directory
dsh plugin --profile web remove @sulytwelve/dsh-machine-status
# then restart the DSH host process you run (DSH provides no unit or service manager)
```

The plugin-install backup of the profile manifest is
`~/.dsh/profiles/web/package.json.bak-20261118-ms`; restoring it is equivalent to removing the
dependency and bundle entry by hand.

## Failure semantics

- A failed collector is data, not an exception: the affected fields are `unknown`, the rest of the
  sample still lands, and the status is at least `degraded`.
- A failed write keeps the previous complete snapshot; the sampler exits non-zero and systemd's
  service result becomes the independent evidence.
- Notifications are opt-in. An unchanged incident produces no second notification.
