# Changelog

## 0.1.2 — 2026-11-18

Documentation only; no runtime or behavior change.

### Fixed

- Removed the `systemctl restart dsh-web` command from the install and rollback steps entirely.
  DSH's CLI does not provide or manage a systemd unit, and the reference host's unit is our own
  local deployment; the docs now only say to restart whatever process serves the profile.

## 0.1.1 — 2026-11-18

Documentation only; no runtime or behavior change.

### Fixed

- The install instructions no longer imply that DSH's CLI provides or manages a systemd unit. It
  does not: the `dsh-web.service` used on the reference host is a locally authored deployment unit.
  The README, upgrade and rollback steps now say to restart whatever process serves the profile and
  mark the `systemctl` line as reference-host-only.

## 0.1.0 — 2026-11-18

First release. A read-only host health snapshot for DSH 0.2.2-rc.3, profile `web`.

### Why

The operator answered "is the machine healthy" by running `df`, `systemctl` and `journalctl` on
every ask, and the agent had no cheap way to ask the same question. This plugin samples the machine
once on an independent timer, keeps the last observation with its time and evidence, and lets one
tool call answer from a file.

### Added

- `machine_status` Host tool: `op=status` compact summary with evidence ids, `op=evidence` one
  drill-down, `op=sources` paths/freshness/heartbeat. Read-only; never samples, executes, or asks for
  approval.
- Independent systemd **user** service + timer, no root: 60 s cadence, boot sample, per-collector
  timeouts, atomic writes, previous snapshot retained on failure.
- Collectors: disk (`statfs` per configured mount), memory and load (`/proc`), systemd units
  (`systemctl show`), backup freshness from the job's own completion record, global IPv6 /64
  prefixes (`ip -6 -j`).
- Deterministic decision policy: two consecutive breaches open one incident, two healthy samples
  close it; unknown telemetry never closes an incident; boot-id change restarts streaks and records
  `host.reboot`; prefix rotation is information only.
- Opt-in notifications: one JSONL row per incident transition, nothing by default.
- CLI: `status`, `evidence`, `sources`, `doctor`, `notifications`, `export`, `sample`, `install`,
  `uninstall`, `version` with documented exit codes.
- `plugin-loaded.json` heartbeat records the running process's own `ctx.tools.schemas()` projection
  (`modelFacing`), which is what makes installation verifiable without the Web GUI.
- Tests (10 files, 55 assertions) and a clean-install path that runs them from the packed tarball.

### Verified on the target host

SULY-HPED800, Arch Linux, DSH 0.2.2-rc.3, profile `web`, 2026-11-18:

- `dsh plugin --profile web add …` installed the package and selected the bundle automatically;
  `dsh --profile web --dump-config` shows the `machine-status` row.
- After the reference host's own `dsh-web` unit was stopped and started (not something DSH's CLI
  provides or manages), the new process (pid 12683) wrote a heartbeat with
  `tool.modelFacing: true` and `schemaNames: ["machine_status"]`; the journal showed no plugin error.
- `doctor` reports no failures; the real sample is `HEALTHY` with dsh-web/forgejo active, backup
  success 4 h 29 m old and `2408:825c:260:b0c::/64` on `eno1`.
- Two repeated `status` calls left `snapshot.json` byte-identical and unchanged in mtime.
- Measured: 26 ms sampler duration, 9,437 B snapshot, 94.8 ms CPU per run; collector timings
  disk 0 / memory 1 / services 12 / backup 10 / IPv6 2 ms.

### Limits

- `memory-probe` is plugin-hosted and reported unknown; no telemetry source is guessed.
- Backup artifact names are journal evidence and stay opt-in (the `dsh` user cannot read other
  units' journals by default); the default evidence is the unit's successful completion.
- A model-facing call in a live server session was not exercised; the registry projection and the
  CLI read path were.
- Collectors target Linux; other platforms degrade to `unknown` for Linux-specific sources.
- Thresholds are calibrate-required until measured per host (see the README table).

### Rollback

`dsh-machine-status uninstall [--purge]`, then
`dsh plugin --profile web remove @sulytwelve/dsh-machine-status`, then restart the DSH host process
you run (DSH does not provide or manage a systemd unit).
