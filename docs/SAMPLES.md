# Sample outputs

The first block is from the reference host (SULY-HPED800, 2026-11-18 09:05 +08). The remaining
blocks are deterministic fixture outputs from the same renderer and are labeled as such.

## Healthy · real host

```
machine_status: HEALTHY · SULY-HPED800 · sample 2026-11-18T09:05:29+08:00 · 11s old (ttl 180s)
disk     / 8.9% used, 106 GiB free · /srv/storage 2.0% used, 108 GiB free
memory   2.5 GiB available / 3.7 GiB · load 0.1 0.04 0.01 · 4 cpus
services dsh-web active/running · forgejo active/running · memory-probe unknown (plugin-hosted service has no systemd unit; no telemetry source is configured)
backup forgejo-backup.service success/0 · last completion 4h29m ago (limit 26h) · artifact unknown (journal evidence is opt-in (backup.journal); unit completion is the default evidence)
ipv6     eno1 2408:825c:260:b0c::/64
findings 0 · unknowns 1 · incidents 0
  [unknown expected] svc.unhealthy memory-probe: plugin-hosted service has no systemd unit; no telemetry source is configured · hint: telemetry: none evidence=svc:memory-probe
evidence host disk:/ disk:/srv/storage mem load svc:dsh-web svc:forgejo svc:memory-probe backup:forgejo-backup.service ipv6:eno1
```

## Stale · last sample healthy, now older than the TTL (fixture)

```
machine_status: STALE · SULY-HPED800 · last sample 2026-11-18T08:59:32+08:00 · 7m28s old (ttl 180s)
last known: HEALTHY · findings 1 · open incidents 0
diagnostic: reading never samples; this is not current machine state. Run `dsh-machine-status doctor`.
```

## Missing · no sample has ever been collected (fixture)

```
machine_status: MISSING · no snapshot has been collected
diagnostic: no snapshot at /home/dsh/.local/state/dsh-machine-status/snapshot.json
diagnostic: no sample at the configured state directory. Run `dsh-machine-status install` as the DSH user, or check the sampler timer.
```

## Partial collector failure (fixture)

```
machine_status: DEGRADED · SULY-HPED800 · sample 2026-11-18T09:07:00+08:00 · 0s old (ttl 180s)
disk     / 10.0% used, 107 GiB free · /srv/storage 2.0% used, 109 GiB free
memory   2.6 GiB available / 4.0 GiB · load 0.06 0.04 0.01 · 8 cpus
services dsh-web active/running · forgejo active/running · memory-probe unknown (plugin-hosted service has no systemd unit; no telemetry source is configured)
backup unknown (ETIMEDOUT systemctl show timed out)
ipv6     eno1 2408:825c:260:b0c::/64
findings 3 · unknowns 1 · incidents 0
  [warning] backup.failed backup: backup collector unavailable observed=unknown expected=a fresh observation evidence=backup:forgejo-backup.service
  [warning] backup.stale backup: backup collector unavailable observed=unknown expected=a fresh observation evidence=backup:forgejo-backup.service
  [warning] collector.failed backup: backup collector failed: ETIMEDOUT systemctl show timed out observed=collector failed expected=ok evidence=collector:backup
  [unknown expected] svc.unhealthy memory-probe: plugin-hosted service has no systemd unit; no telemetry source is configured · hint: telemetry: none evidence=svc:memory-probe
diagnostic: backup unknown (ETIMEDOUT systemctl show timed out)
evidence host disk:/ disk:/srv/storage mem load svc:dsh-web svc:forgejo svc:memory-probe backup:forgejo-backup.service ipv6:eno1
```

## Open incident after two consecutive breaches (fixture)

```
machine_status: DEGRADED · SULY-HPED800 · sample 2026-11-18T09:07:00+08:00 · 0s old (ttl 180s)
disk     / 10.0% used, 107 GiB free · /srv/storage 2.0% used, 109 GiB free
memory   2.6 GiB available / 4.0 GiB · load 0.06 0.04 0.01 · 8 cpus
services dsh-web failed/running result=exit-code · forgejo active/running · memory-probe unknown (plugin-hosted service has no systemd unit; no telemetry source is configured)
backup forgejo-backup.service success/0 · last completion 4h ago (limit 26h) · artifact unknown (journal evidence is opt-in (backup.journal); unit completion is the default evidence)
ipv6     eno1 2408:825c:260:b0c::/64
findings 1 · unknowns 1 · incidents 1
  [critical] svc.unhealthy dsh-web: dsh-web is not healthy (failed) observed=failed/running result=exit-code expected=active/running result=success evidence=svc:dsh-web
  [unknown expected] svc.unhealthy memory-probe: plugin-hosted service has no systemd unit; no telemetry source is configured · hint: telemetry: none evidence=svc:memory-probe
incident [open] svc.unhealthy dsh-web since 09:07:00 evidence=svc:dsh-web
evidence host disk:/ disk:/srv/storage mem load svc:dsh-web svc:forgejo svc:memory-probe backup:forgejo-backup.service ipv6:eno1
```

## Evidence drill-down (fixture)

```
machine_status evidence backup:forgejo-backup.service · sample sample-1 · sampled 2026-11-18T09:07:00+08:00
{
  "source": "systemctl show",
  "sampledAtMs": 1794964020859,
  "job": "forgejo-backup.service",
  "lastResult": "success",
  "execMainStatus": 0
}
```

## Export (fixture)

`dsh-machine-status export --finding svc.unhealthy --json` returns the finding with its evidence and
advisory expiry:

```json
{
  "schema": "dsh.machine-status/export@1",
  "sampleId": "…",
  "observedAt": "2026-11-18T09:07:00+08:00",
  "observedAtMs": 1794964020000,
  "expiresAt": "2026-11-18T09:10:00+08:00",
  "expiresAtMs": 1794964200000,
  "findings": [{ "ruleId": "svc.unhealthy", "severity": "critical", "subject": "dsh-web", "evidence": { "…": "…" } }],
  "note": "Read-only export. Expiry is advisory: no memory consumer may treat this as current machine state after expiresAt; the receiving store must enforce it."
}
```
