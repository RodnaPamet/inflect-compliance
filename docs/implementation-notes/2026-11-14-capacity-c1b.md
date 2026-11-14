# 2026-11-14 — Capacity budget C1b: app, worker and the scanner re-sized from measured peaks

**Commit:** see the `claude/capacity-c1b` branch (`feat(deploy): capacity budget C1b …`).

## Design

C1 (2026-11-12, [note](2026-11-12-capacity-c1.md)) limited every container on
the production VM, but set `app` and `worker` at a PROVISIONAL 1,536 MiB each:
their only peaks covered 24 minutes after a restart, with no nightly job in
them. C1b re-sizes them from a day of the capacity recorder's history, and
applies the harness scanner cut the owner approved on 2026-11-13.

### The measurement

`VM capacity` with `mode: history`, run 43566712099, 2026-11-14 12:42 UTC, a
24-hour window. The recorder covered 140 of 144 ten-minute passes; the only gap
is the 47 minutes before it was installed. The 00:15–01:45 UTC parser window
had 9 of 9 passes and the 02:00–05:30 UTC nightly window 22 of 22. Figures in
MiB. "Max peak" is the highest cgroup `memory.peak`, the kernel's high-water
mark for one container start.

| Container | 24 h: peak current / max peak / peak anon / restarts | Parser window: max peak | Nightly window: max peak |
| --- | --- | --- | --- |
| app | 475 / 593 / 445 / 25 | 593 (restarted) | 500 (restarted at 02:02) |
| worker | 323 / 385 / 304 / 25 | 385 (restarted) | 355 (restarted) |
| clamav | 1,142 / 2,099 / 959 / 0 | 2,099 | 2,099 |
| postgres | 291 / 343 / 23 / 0 | 343 (rose in the window) | 343 |
| harness-scanner | 132 / 134 | 134 | 134 |
| harness-egress | 52 / 85 | 85 | 85 |
| legacy-mcp-proving | 93 / 108 | 108 | 108 |
| caddy | 38 / 51 | 51 | 51 |
| redis | 18 / 30 | 30 | 30 |
| watchtower | 33 / 39 | 39 | 39 |
| pgbouncer | 9 / 14 | 14 | 14 |

The 25 restarts of `app` and `worker` are Watchtower recreating them on every
image publish, so each of their `memory.peak` values covers a short lifetime.
CPU is negligible: the highest 10-minute average is 0.12 cores for `app` and
0.10 for `clamav`.

### The limits

| Service | File | Before | After | Basis |
| --- | --- | ---: | ---: | --- |
| app | prod | 1536m, heap 1024 | **1024m, heap 768** | 1.5 × 593 = 890, rounded up to 1024 |
| worker | prod | 1536m, heap 1024 | **1024m, heap 768** | 1.5 × 385 = 578; 768 would satisfy 1.5×, and 1024 is deliberate (below) |
| harness-scanner | scanner overlay | 512m | **256m** | owner-approved 2026-11-13: peaks 155 (C0) and 134; 1.5 × 155 = 233 |
| clamav | prod | 3072m | 3072m | the signature reload: peak 2,099, about 1.46× |
| postgres | prod | 2048m | 2048m | peak 343; pgvector sits inside this limit by owner decision (2026-11-13) |
| redis | prod | 768m | 768m | twice `--maxmemory 256mb`, for the AOF-rewrite fork |
| caddy, pgbouncer, watchtower | prod | 256m, 128m, 128m | unchanged | at their floors |
| harness-egress, legacy-mcp-proving | overlays | 256m, 256m | unchanged | at the Node floor |
| **Total** | | **10,496 MiB** | **9,216 MiB** | budget 14,848 MiB; stricter line 14,467 MiB |

The V8 heap moves with the limit. 768 under 1024m is three quarters, the top
of the guard's band (above half, at most three quarters), and leaves 256 MiB
for buffers, code and native memory. `app`'s highest anonymous memory was 445
MiB, the worker's 304.

### What it leaves for the AI completeness services

Today's 9,216 plus the standing additions (embedding 1,024 + reranking 1,536 +
PII 717 + NeMo 1,024 = 4,301) is 13,517 MiB: about 950 MiB under the stricter
line and about 1,330 under 14,848. No resize; D-CAP-1 is satisfied by the
smaller pieces plus C1b, and is revisited when a phase measures a service
above its estimate.

The window rule: the always-on containers' highest `memory.peak` over the
parser window sum to 3,881 MiB. With the standing additions at their limits
(4,301) and the parser's 3,072, that is 11,254 MiB, under the line.

### Automation rules from web events, turned on

The same pull request turns `AUTOMATION_WEB_EVENTS_ENABLED` on (owner decision,
2026-11-14), as `AUTOMATION_WEB_EVENTS_ENABLED: "1"` in `app`'s `environment:`.
`VM check` `automation-rules` (run 43596452819, 2026-11-14 12:49 UTC) counted
0 enabled rules across 0 tenants, so turning it on wakes nothing today; rules
created from now on fire from web events. The rollout text in
`docs/deployment.md` said to set it in `.env.prod`; it now names the compose
file, because the switch is not a secret and `environment:` overrides
`env_file:` anyway. It shares C1b's one `apply`, and so its one recreate of
`app`.

## Files

| File | Role |
| --- | --- |
| `deploy/docker-compose.prod.yml` | `app` and `worker` 1024m with a 768 heap; `AUTOMATION_WEB_EVENTS_ENABLED` on `app` |
| `deploy/docker-compose.harness-scanner.yml` | `harness-scanner` 256m |
| `deploy/harness-scanner/README.md` | the scanner's memory row |
| `docs/ai-architecture-roadmap.md` | § Capacity budget: the ledger lines, the arithmetic, the window rule, C1b done, the D-CAP-1 row |
| `docs/sizing.md`, `docs/deployment.md` | the limits, the total, the recorder, the web-events switch |

## Decisions

- **The worker keeps 1024, not 768.** The 24 hours are one night. The Sunday
  05:45 integration passport and the month-start evidence emitters are not in
  them, and a V8 heap abort kills a job silently (exit 134, no OOM kill).
  Tightening the worker to 768 is a later step, once the recorder's history
  (it keeps 8 days) holds a Sunday and a month start.
- **`app` and `worker` peaks are short-lived.** Watchtower recreated both 25
  times in the window, so no single `memory.peak` spans the whole night. The
  1.5× factor and the worker's extra headroom cover that; the recorder will
  show any peak that approaches the new limit.
- **Only three limits move.** C1's "reset every limit to 1.5× its peak" is
  applied where a service's mechanics allow; clamav, postgres and redis keep
  the limits their mechanics need, and the rest are at their floors.
- **The guards hold rules, not values.** `tests/guards/deploy-compose-canonical.test.ts`
  checks every limit is present, the total is within 14,848 MiB, batch services
  are capped at one core, and each heap sits in its band. None pins a figure, so
  none changed.

## Rollback plan

Revert the commit in a pull request, merge, then `VM apply` → `preflight`, then
`apply` (and the `Scanner VM` workflow's `configure`, `stop`, `start` for the
scanner). In an emergency, `VM apply` → `rollback-preflight`, then `rollback`
restores the newest compose backup that differs from the live file. A running
container's limit can also be raised in place with `docker update --memory`,
which does not raise the V8 heap (see the C1 note).
