# Machine status

A read-only health snapshot for the host that runs DeepSeek Harness. The plugin registers one
tool, `machine_status`, which reads a JSON snapshot produced by an independent systemd user timer.
It never samples, executes, or asks for approval on a status call.

## Behavior

- Sampling runs as a **systemd user service + timer** every 60 s, under the same unprivileged user
  as the DSH service. No root, no agent session required, and collection survives Host restarts
  while that user has lingering enabled.
- One call returns a compact summary: disk per mount, memory/load/CPU count, configured systemd
  services, backup freshness and IPv6 prefixes, plus observations and evidence ids.
- `op=evidence` returns one observation; `op=sources` explains paths, freshness and sampler state.
- Every response carries the observation time, age and freshness TTL. A stale snapshot is labeled
  `STALE` and never presented as current.
- Two consecutive breaches open one incident; two consecutive healthy samples close it. Missing
  telemetry is tracked separately and cannot close an incident. Notifications are off by default and,
  when enabled, produce one durable row per transition.

## Configuration

Row config (`cordis.patch.yml`) accepts `enabled`, `ttlMs`, `stateDir`, `notify.enabled`.
Sampling policy (mounts, interface, services, backup job, thresholds) lives in
`~/.local/state/dsh-machine-status/config.json`, written by `dsh-machine-status install` and editable
by the operator. Every numeric default is either measured (documented in the README table) or
**calibrate-required**.

## Boundaries

- Linux collectors only; other platforms report `unknown` for Linux-specific sources.
- `memory-probe` is plugin-hosted and has no systemd unit, so it is reported unknown unless a
  telemetry source is configured later.
- Backup artifact names are journal evidence and opt-in; the default evidence is the unit's
  successful completion time and exit status.
- No remediation, no GUI, no approval interception, no execution authority.
