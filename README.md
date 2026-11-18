# dsh-machine-status

Read-only host health snapshots for DeepSeek Harness (DSH) 0.2.2-rc.3, profile `web`.
One model-facing tool answers "what did the machine last report, when, what changed and why it
needs attention" without running a command, sampling on demand, asking for approval, or showing a GUI.

An independent **systemd user timer** samples the host every 60 s and writes three versioned JSON
documents. The Host row and the CLI only read them. Repeated status calls cost no new sampling.

## Verified host contract (not assumed)

Checked against the installed 0.2.2-rc.3 sources on 2026-11-18:

| Contract | Verification |
|---|---|
| Host plugin form `export function apply(ctx, config)` + `export const inject = ['tools']` | `@deepseek-ai/dsh-plugin-manager` docs; the installed `@sulytwelve/dsh-context-manager` uses the same form |
| `ctx.tools.register(def)` returns the disposer; definitions may be plain objects without `@deepseek-ai/*` imports | `@deepseek-ai/dsh-tools` service contract; context-manager `index.js:204-217,724` |
| Tool shape `{name, description, parameters, output:{schema, render}, execute}`; `render` returns `[{type:'text', text}]` | `@deepseek-ai/dsh-tool-todo/src/index.ts:136-213` |
| Bundle manifest `dsh.bundle.patch` + `cordis.patch.yml` `- insert:` row | installed context-manager `package.json`, `cordis.patch.yml` |
| `dsh plugin --profile web add <spec>` installs the package **and** selects the bundle in `dsh.profile.bundles` | run against the target profile on 2026-11-18; `dsh-plugin-manager/src/index.ts:1270-1288` |
| `ctx.tools.schemas()` projects the registered tool into the model-facing schema list | invoked from `apply`; the heartbeat records `modelFacing: true` |

## How it works

```
systemd user timer (60 s)
  └─ bin/sampler.mjs  → collects (timeouts, read-only)
                      → evaluates rules + incident streaks
                      → atomic writes: snapshot.json, state.json, status.json
                                               (notifications.jsonl when opted in)

DSH Host row `machine-status`          CLI `dsh-machine-status`
  └─ machine_status tool (pure read)    └─ status / evidence / sources / doctor / export
```

No part of the read path spawns a process, writes machine state, or calls a model.
The plugin's only side effect is `plugin-loaded.json`, a heartbeat that records whether the
running Host registry projects `machine_status` into the model-facing schemas.

## Install

### 1. Plugin row (on the DSH host, as the DSH user)

```sh
dsh plugin --profile web add github:Sulytwelve/dsh-machine-status#v0.1.4
```

This also appends the bundle to `dsh.profile.bundles` (verified on the reference host; no hand edit
needed).

Restart the DSH process that serves the profile so it loads the new JavaScript. **DSH's CLI does not
install, provide, or manage a systemd unit** — how that process is supervised is deployment-specific.
Use whatever starts your server: a terminal launch, a container, or your own supervisor.


### 2. Sampler timer (same user, no root)

```sh
node <profile>/node_modules/@sulytwelve/dsh-machine-status/bin/cli.mjs install
# or, with the package on PATH: dsh-machine-status install
```

`install` writes `~/.local/state/dsh-machine-status/config.json`, copies the runtime to
`~/.local/lib/dsh-machine-status/`, writes two user units and enables the timer.
The user timer survives logout only with lingering enabled (`loginctl show-user <user> -p Linger`);
this host already reports `Linger=yes`.

`dsh-machine-status install --dry-run` prints every action without changing anything.

## Paths and permissions

| Path | Owner / mode | Purpose |
|---|---|---|
| `~/.local/state/dsh-machine-status/` | DSH user, `0700` | config, snapshot, status, state, notifications |
| `…/snapshot.json`, `status.json`, `state.json` | `0600` | versioned documents; every write goes through a same-directory temp + rename |
| `~/.local/lib/dsh-machine-status/` | DSH user | stable runtime copy used by the units |
| `~/.config/systemd/user/dsh-machine-status.{service,timer}` | DSH user | user units |
| `~/.dsh/storages/agent_memory` | **never touched** | owned by the context-manager plugin |

Cleanup ownership: this plugin owns only the three paths above. `uninstall` keeps the state
directory unless `--purge` is passed; `--purge` removes only its own directory.

## Tool usage

`machine_status` with `op=status` (default), `op=evidence&id=…`, or `op=sources`.
The model sees a compact summary with stable evidence ids; drill-down is one more call.

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

Stale data is never presented as current:

```
machine_status: STALE · SULY-HPED800 · last sample … · 7m28s old (ttl 180s)
last known: HEALTHY · findings 0 · unknowns 1 · open incidents 0
diagnostic: reading never samples; this is not current machine state. Run `dsh-machine-status doctor`.
```

More samples: [docs/SAMPLES.md](docs/SAMPLES.md).

## CLI

| Command | Behavior |
|---|---|
| `status [--json]` | the same summary as the tool; exit 0 fresh/healthy, 2 degraded/stale, 3 missing/unknown, 1 failure |
| `evidence <id> [--json]` | one evidence record from the current snapshot |
| `sources [--json]` | paths, mtimes, freshness, heartbeat, sampler state |
| `doctor [--json]` | writability, documents, heartbeat, runtime version, timer, sampler result |
| `notifications [--limit N] [--json]` | opt-in transition log |
| `export [--finding RULE] [--json]` | read-only finding export with observation time and advisory expiry |
| `sample [--json]` | run one sampling cycle now (what the timer runs) |
| `install [--dry-run] [--force]` / `uninstall [--purge]` | manage the user units and runtime copy |
| `version` | package and Node version |

`--state-dir DIR` (or `DSH_MACHINE_STATUS_STATE_DIR`) overrides the state directory for testing.

## Decision policy

- A rule breaches or is healthy per sample; **two consecutive breaches** open one incident,
  **two consecutive healthy samples** close it.
- `unknown` (failed collector, unreadable mount, unreadable unit) is tracked separately in
  `unknowns`, not in `findings`: it never closes an incident and never counts as healthy. An
  **expected** unknown is a source the operator declared absent (`telemetry: none`, e.g. the
  plugin-hosted memory probe): it is listed once with its hint, does not degrade the sample and is
  not repeated as a finding. Any unexpected unknown still degrades the sample.
- Boot-id change (host reboot) restarts per-rule streaks and records `host.reboot` information.
- A changed IPv6 /64 prefix is **information only**; a missing global address alerts only when
  `collect.ipv6.requireGlobal` is true.
- With `notify.enabled: false` (default) no notification is written at all. When enabled, exactly one
  JSONL row is written per incident transition; an unchanged failure is not repeated.

## Defaults: measured or calibrate-required

Measured on **SULY-HPED800** (Arch Linux, 4 GB RAM, Node v26.13.1, DSH 0.2.2-rc.3) on
**2026-11-18 09:05 +08**, sample `387e0698-901d-4d4f-b2ac-6d473bad6205`:

| Setting | Value | Class | Provenance |
|---|---|---|---|
| sampler wall duration | 26 ms | measured | `snapshot.durationMs` |
| collector duration | disk 0 ms, memory 1 ms, services 12 ms, backup 10 ms, ipv6 2 ms | measured | `snapshot.collectors.*.durationMs` |
| sampler CPU per run | 94,795,000 ns ≈ 94.8 ms | measured | `systemctl --user show … -p CPUUsageNSec` |
| document sizes | snapshot 9,437 B; status 902 B; state 4,245 B | measured | `fs.statSync` |
| backup age at the sample | 16,172,019 ms ≈ 4 h 29 m | measured | `collectors.backup.ageMs` |
| IPv6 /64 lease at the sample | valid 6,706 s / 7,022 s (≈1.9 h) | measured | `ip -6 -j addr show dev eno1` |
| sampling cadence | 60 s | calibrate-required | brief starting policy; not tuned |
| freshness TTL | 180 s | calibrate-required | brief starting policy |
| disk floor | 10 % free **or** 2 GiB | calibrate-required | not measured against this host |
| disk drop | 20 % and 1 GiB over 6 samples | calibrate-required | not measured |
| memory floor | 10 % and 512 MiB | calibrate-required | not measured |
| load threshold | 2 × CPU count (load1) | calibrate-required | not measured |
| backup age limit | 26 h (daily 04:17 job + slack) | calibrate-required | job schedule observed, limit not tuned |
| incident open/close | 2 / 2 samples | calibrate-required | brief starting policy |
| notification retention | 512 rows | calibrate-required | not measured |
| collector timeout | 2,000 ms | calibrate-required | max observed 12 ms, 2 s is headroom |
| unknown telemetry | separate `unknowns`; `telemetry: none` is expected and does not degrade | product choice | memory-probe declared absent with a hint |
| notifications | off | product requirement | silent by default |

## Tests

```sh
npm test          # 10 files, 55 assertions; no dependencies, no Linux required
npm pack          # tarball includes test/
```

The clean-install check used on the target host:

```sh
mkdir /tmp/dsh-ms && tar -xzf sulytwelve-dsh-machine-status-0.1.4.tgz -C /tmp/dsh-ms
cd /tmp/dsh-ms/package && node test/*.mjs
```

Tests cover a healthy cache hit, sustained service failure, stale backup, routine prefix change,
host reboot, partial collector failure, recovery, the stale-but-last-known-healthy sample, one
notification per transition, zero default notifications, zero sampler starts from status reads,
failed writes keeping the previous snapshot, and the unit/config installer.

## Limits and boundaries

- Collectors target Linux. On other platforms disk/memory degrade to OS fallbacks and
  services/backup/IPv6 report `unknown` with a diagnostic; nothing throws.
- `memory-probe` has no systemd unit (it is a plugin row). It is declared `telemetry: none`, so it is
  listed once as an **expected** unknown with its hint; it does not degrade the sample and does not
  repeat as a finding. It is never guessed as healthy.
  This plugin does not read the context-manager's data.
- Backup evidence is the job's systemd completion record (`Result=success`, `ExecMainStatus=0`,
  completion time). The artifact name/count lives in a journal line the `dsh` user cannot read by
  default; set `collect.backup.journal: true` only after granting journal read access.
- No remediation commands are produced or executed; remediation is out of scope.
- A model-facing call in a live server session was **not** exercised; the heartbeat proves the
  running process's registry projects the tool (`modelFacing: true`), and the CLI exercises the same
  read path.

## Rollback

```sh
# sampler
dsh-machine-status uninstall            # keeps state for postmortem
dsh-machine-status uninstall --purge    # also removes the state directory

# plugin row
dsh plugin --profile web remove @sulytwelve/dsh-machine-status
# then restart the DSH host process you run (see Install §1); DSH provides no unit
```

The profile `package.json` backup taken before installation is
`~/.dsh/profiles/web/package.json.bak-20261118-ms`. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Distribution

Three install paths, in preference order:

1. **npm** — the repository carries a tag-triggered publish workflow; once the `NPM_TOKEN` secret is
   configured, a tagged release publishes to the registry and installs as a normal package.
2. **GitHub tag** — `dsh plugin --profile web add github:Sulytwelve/dsh-machine-status#vX.Y.Z` (pin the tag).
3. **Release tarball URL** — `dsh plugin --profile web add https://github.com/Sulytwelve/dsh-machine-status/releases/download/vX.Y.Z/sulytwelve-dsh-machine-status.tgz`.

**Upgrading:** DSH hot-updates code inside an installed plugin (HMR), but it does not overwrite an
installed plugin package. A new version therefore needs remove then add (restart only if the Host
does not hot-load the new module generation):
tag, then restart the process that serves the profile:

```sh
dsh plugin --profile web remove @sulytwelve/dsh-machine-status
dsh plugin --profile web add github:Sulytwelve/dsh-machine-status#v0.1.4
```

Until npm publishing is enabled, use the GitHub tag or the release tarball spec after the remove.
## License

MIT — see [LICENSE](LICENSE).
