# Deployment Guide

> **Policy twin:** this guide is the *operational how*; the *who-approves-what*
> contract — change classes, approval matrix, emergency bypass, rollback policy —
> lives in [`docs/change-management-policy.md`](change-management-policy.md).

## Quick Start (Local Production)

```bash
# 1. Copy env template
cp .env.production.example .env.production

# 2. Edit .env.production — set ALL secrets:
#    openssl rand -base64 32    (for AUTH_SECRET, JWT_SECRET)
#    Set OAuth credentials, POSTGRES_PASSWORD, NEXTAUTH_URL

# 3. Start
npm run prod:up
# or: docker compose -f docker-compose.prod.yml up -d --build

# 4. Verify
npm run smoke:staging   # works against localhost:3000
curl http://localhost:3000/api/health | jq .
```

## Architecture

```
┌───────────────────────────────────────────────┐
│ docker-compose.prod.yml                       │
│                                               │
│  ┌──────────┐ internal    ┌────────────────┐  │
│  │ db       │◄────────────│ app            │  │
│  │ pg:16    │  network    │ :3000          │  │
│  │ (no port │             │                │  │
│  │  exposed)│             │ entrypoint:    │  │
│  └────┬─────┘             │  1. migrate    │  │
│       │                   │  2. next start │  │
│  [pgdata]                 └──────┬─────────┘  │
│                           [uploads:/data]     │
└───────────────────────────────────────────────┘
```

## Required Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `POSTGRES_PASSWORD` | ✅ | Docker Compose DB password |
| `AUTH_SECRET` | ✅ | ≥16 chars, `openssl rand -base64 32` |
| `JWT_SECRET` | ✅ | ≥16 chars, `openssl rand -base64 32` |
| `NEXTAUTH_URL` | ✅ | Canonical URL (e.g. `https://app.example.com`) |
| `AUTH_URL` | ✅ | Same as NEXTAUTH_URL |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth provider |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth provider |
| `MICROSOFT_CLIENT_ID` | ✅ | OAuth provider |
| `MICROSOFT_CLIENT_SECRET` | ✅ | OAuth provider |
| `UPLOAD_DIR` | ✅ | Set to `/data/uploads` (Docker) |
| `DATA_ENCRYPTION_KEY` | ✅ **REQUIRED** in production | ≥32 chars, `openssl rand -base64 48`. **Production startup exits 1 if missing, too short, or equal to the documented dev fallback.** Both the Next.js app server and the BullMQ worker enforce this. See [encryption docs](encryption-data-protection.md). |
| `REDIS_URL` | ✅ **REQUIRED** in production (GAP-13) | Connection string. **Must be AUTHENTICATED in production** — carry a non-empty password (`redis://:PASSWORD@HOST:6379`, `redis://user:pw@host`, or `rediss://:token@host` for TLS). A bare `redis://host:6379` is rejected. **Production startup exits 1 if unset OR unauthenticated under `NODE_ENV=production`** (`src/env.ts` schema check + `src/instrumentation.ts` defense-in-depth). The `/api/readyz` and legacy `/api/health` probes also PING Redis on every check; a missing or broken Redis returns 503 → orchestrator stops routing traffic. Hosts: rate limits (login brute-force, invite redemption, email dispatch), BullMQ job queue, session/cache coordination. |
| `REDIS_PASSWORD` | ✅ **REQUIRED** for production-like Compose | The password the bundled Redis container enforces via `--requirepass`. `docker-compose.prod.yml`, `docker-compose.staging.yml`, and `deploy/docker-compose.prod.yml` all use `${REDIS_PASSWORD:?…}` — `docker compose up` **aborts** before the container is created if it is unset. `docker-compose.prod.yml` and `docker-compose.staging.yml` also build `REDIS_URL` from it automatically (`redis://:${REDIS_PASSWORD}@redis:6379`); `deploy/docker-compose.prod.yml` does **not** — that stack's `REDIS_URL` comes from the host's `.env.prod` with the credential already embedded, so the two must be kept consistent (see "The production VM's Compose file is repo-canonical"). Generate with `openssl rand -base64 32`. Not needed when connecting to an external managed Redis (set `REDIS_URL` directly instead). |
| `CORS_ALLOWED_ORIGINS` | Optional | Comma-separated origins |
| `EGRESS_PRIVATE_CIDR_ALLOWLIST` | — | **Self-hosted only.** Comma-separated CIDRs this install may reach despite the SSRF guard refusing private space, e.g. `10.0.0.0/8,192.168.0.0/16`. Inert on hosted Inflect. Cloud metadata (`169.254/16`, `fe80::/10`) and loopback (`127/8`, `::1`) stay refused inside it, so `0.0.0.0/0` is a wide allowlist and still not a metadata primitive. Never tenant-configurable. |
| `NOTIFICATIONS_TZ` | Optional (default `Europe/London`) | IANA timezone (DST-aware) for the daily task-due deadline notification cron. Sets **both** the 08:00 firing time **and** the "due today / tomorrow / in a week" calendar-day classification — one zone, so a task due near local midnight is bucketed by the local calendar day rather than the UTC one. Must be a valid IANA zone name (`src/env.ts` rejects an invalid zone at startup). |
| `ANTHROPIC_WORKSPACE_ID` | Optional | Only for an **organisation-level** `ANTHROPIC_API_KEY` — a key created inside a workspace needs nothing here. Anthropic refuses an organisation-level key's requests with HTTP 400 unless each names its workspace, so when this is set (a `wrkspc_…` identifier, not a secret) every request to the Anthropic API — the posture summary, AI risk suggestions and the Flue runtime's external provider — carries `anthropic-workspace-id: <id>`; unset, none does. It reaches the `app` and `worker` containers the way `ANTHROPIC_API_KEY` does: through the service's `env_file:` (`/opt/inflect/.env.prod` on the production VM). No Compose file lists either key under `environment:`, and none should — a service-level `environment:` entry overrides the env file, so an empty interpolation there would blank the value the container was given. |
| `AGENT_FLUE_MODEL` | Optional (default `claude-sonnet-5-5`) | The model the Flue agent runtime's external provider names, and the default model `npm run skills:evaluate` records skill evaluations against. Its own variable on purpose: the compliance-posture summary and the AI risk suggestions keep `ANTHROPIC_MODEL` (default `claude-haiku-4-5`), and setting one never moves the other. The credential and workspace are still the shared `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID`. A `LOCAL_ONLY` tenant's run never reads it; its model is `AI_LOCAL_MODEL`. It reaches the `app` and `worker` containers through the service's `env_file:`, like `ANTHROPIC_API_KEY`. |
| `AGENT_FLUE_WORKER_MODEL` | Optional (unset) | The WORKER role's model (D-L3-1): the model a Flue run's subagents run on, on the same external provider, key and workspace as `AGENT_FLUE_MODEL`. Registered beside it at boot, never instead of it. Unset, blank or equal to `AGENT_FLUE_MODEL`, subagents run on the run's own model, which is the behaviour before the variable existed; each run's opening audit entry records both models and whether the worker's was configured or a fallback. A `LOCAL_ONLY` tenant's run never reads it; both its roles use `AI_LOCAL_MODEL` or are refused. |
| `AUTOMATION_WEB_EVENTS_ENABLED` | Optional (unset = off) | Whether automation events emitted in the **web** process (a task, risk or control created through the UI or the API) reach the job queue and fire automation rules. Off by default; see "Automation rules from web events" below before turning it on. `1` or `true` turns it on; any other value is off. **On in production** since 2026-11-14 (owner decision): `deploy/docker-compose.prod.yml` sets it to `"1"` in the `app` service's `environment:`, which overrides any value in `.env.prod`. |
| `EVALS_CARD_HIDDEN_ORG_SLUGS` | Optional (unset) | The opt-out list for the read-only **Evaluations** card on `/org/<slug>/settings`. Every organization's admins (owner or admin) see the card by default, a newly created organization included; comma-separated organization slugs listed here do not. Unset or empty hides it nowhere. The card describes the garak and Inspect CI nightlies (`garak.yml`, `agent-evals.yml`) and where their repository variables `GARAK_ENABLED` / `AGENT_EVALS_ENABLED` are set; it is static content, reads no live state and calls nothing, so this opt-out list is all there is to configure. Not a sub-processor. |

## Docker Compose (Self-hosted / VPS)

### Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### Commands

| Action | Command |
|--------|---------|
| Start | `npm run prod:up` |
| Stop | `npm run prod:down` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f app` |
| DB logs | `docker compose -f docker-compose.prod.yml logs -f db` |
| Rebuild | `docker compose -f docker-compose.prod.yml up -d --build --force-recreate` |
| Shell | `docker compose -f docker-compose.prod.yml exec app sh` |
| Reset data | `docker compose -f docker-compose.prod.yml down -v` |
| Smoke check | `npm run smoke:staging` |

### How it works

1. **DB starts** → Postgres 16 on internal network (no port exposed externally)
2. **App starts** → `entrypoint.sh` runs `prisma migrate deploy` then `next start`
3. **Volumes** → `inflect-prod-pgdata` (DB) + `inflect-prod-uploads` (files) persist across restarts
4. **Health** → Docker checks `/api/health` every 15s

### Redis authentication — per-environment policy

Redis carries sessions, rate-limit counters, and the BullMQ job
queue. An unauthenticated Redis that is ever network-reachable is
wide open. The policy is environment-specific:

| Environment | Redis auth | How |
|-------------|-----------|-----|
| Local dev (`docker-compose.yml`) | **Unauthenticated**, loopback-only | Redis intentionally runs without `--requirepass` for dev ergonomics, but its host port is bound to `127.0.0.1:6379` — not reachable from the dev machine's network. |
| Staging / Production Compose (`docker-compose.staging.yml`, `docker-compose.prod.yml`, `deploy/docker-compose.prod.yml`) | **Required password** | The bundled Redis container runs `redis-server --requirepass "${REDIS_PASSWORD:?…}"`. The `:?` fail-fast syntax aborts `docker compose up` before the container is created if `REDIS_PASSWORD` is unset. The two root compose files build the app's `REDIS_URL` from it (`redis://:${REDIS_PASSWORD}@redis:6379`); `deploy/docker-compose.prod.yml` has no inline `REDIS_URL` and takes it from the host `.env.prod` instead. |

`src/env.ts` enforces the contract from the application side: under
`NODE_ENV=production` it rejects a `REDIS_URL` that is missing **or**
unauthenticated (no password in the URL) — the process exits 1 at
startup. The structural ratchet at
`tests/guards/redis-production-auth.test.ts` locks the compose-file
shape so a future "simplify" PR cannot quietly drop `--requirepass`.

> **Rollout note.** This change is fail-fast by design. Operators
> **MUST set `REDIS_PASSWORD`** in their `.env.production` /
> `.env.staging` (or `deploy/.env.runtime`) **before** deploying this
> change — otherwise `docker compose up` aborts immediately with a
> clear message. Generate one with `openssl rand -base64 32`. Test
> Redis (`docker-compose.test.yml`) is exempt and stays
> unauthenticated.

### Redis — eviction policy (BullMQ durability)

BullMQ stores job state in Redis. If Redis is configured to **evict**
keys under memory pressure, queued jobs are silently dropped — lost
work, no error. The only BullMQ-safe `maxmemory-policy` is
`noeviction`: Redis then rejects new writes with an `OOM` error,
which surfaces loudly and is alertable, instead of discarding job
records.

| Environment | `maxmemory-policy` | How |
|-------------|--------------------|-----|
| Local dev (`docker-compose.yml`) | `noeviction` | `redis-server … --maxmemory-policy noeviction` |
| Staging / Production Compose | `noeviction` | same flag on each `redis` service `command:` |
| Test (`docker-compose.test.yml`) | `noeviction` (Redis default) | no `maxmemory` cap is set, so eviction never triggers |

With `noeviction` **and** a `maxmemory` cap, a Redis at its memory
ceiling rejects writes — workers fail to enqueue and the failure is
visible — rather than silently discarding job records.

Two layers keep this from regressing:

- `tests/guards/redis-eviction-policy.test.ts` — fails CI if any
  Compose `redis` service reverts to a key-evicting policy.
- `verifyRedisEvictionPolicy` (`src/lib/redis.ts`), called at startup
  from `src/instrumentation.ts` — a best-effort `CONFIG GET` check
  that logs loudly (error in production, warning in dev) if the
  connected Redis is evicting. Skipped quietly when `CONFIG` is
  unavailable, as managed Redis services commonly disable it.

### Background worker

The Next.js `app` container serves HTTP only. **Every background
job runs in a separate `worker` container** — the BullMQ worker
(`scripts/worker.ts`) plus the scheduler (`scripts/scheduler.ts`).
Without it, the 12 repeatable crons in `src/app-layer/jobs/schedules.ts`
never run (task-due reminders, evidence-expiry sweeps, retention,
the notification digest, …) and anything the app enqueues piles up
in Redis unprocessed.

How it is wired:

- The Docker image build (`Dockerfile`) runs `npm run build:worker`,
  which esbuild-bundles the two entrypoints into self-contained
  `dist/worker.mjs` + `dist/scheduler.mjs` (the production image is
  dev-dependency-pruned, so it cannot run the TypeScript sources
  via `tsx`).
- Each production-like Compose file (`docker-compose.prod.yml`,
  `docker-compose.staging.yml`, `deploy/docker-compose.prod.yml`)
  declares a `worker` service using the **same image** as `app`,
  with the ENTRYPOINT overridden to
  `node dist/scheduler.mjs && node dist/worker.mjs` — register the
  repeatable schedules (idempotent), then daemonise the worker.
- `tests/guards/worker-deployment.test.ts` fails CI if the `worker`
  service, the build step, or the build script is dropped.

> **Operator note — the `worker` service runs on the GCP VM.** Watchtower
> swaps the *image* only; it never applies Compose structure changes. Structure
> reaches the VM through `deploy/apply.sh` — see the next section.

### Automation rules from web events (`AUTOMATION_WEB_EVENTS_ENABLED`)

An automation rule fires when an event it is triggered by is emitted and
dispatched to the queue. Events come from two processes. The **worker** emits
them from jobs and scheduled sweeps, and those have always fired. The **web**
process emits them from requests: a task, risk or control created through the
UI or the API. Until #5541, **no web event ever reached the queue.** Next.js
loaded the code that connects the automation bus to BullMQ and the route
handlers as separate module instances, so every route emitted into a bus that
discarded the event. No rule ever fired from a web event, in production
included.

#5541 fixed the bus and put the fix behind `AUTOMATION_WEB_EVENTS_ENABLED`, off
by default (owner decision, 2026-11-13). **It is on in production** (owner
decision, 2026-11-14), set in the repo-canonical compose file, as below.

- **Off** (unset, or any value but `1` / `true`): web events are not
  dispatched, as before. The app logs `automation-bus.web_events_held` once per
  process, at INFO, when it first holds one back.
- **On** (`1` or `true`): web events are dispatched. **Every ENABLED rule wakes
  for new web events at once**: its notifications, webhooks, task creations and
  agent invocations start acting. Nothing is replayed: an event emitted while
  the switch was off is gone, and only events emitted after the app restarts
  with the switch on are dispatched.
- **The worker never reads it.** Worker-emitted events fire whatever it says.

It was off because turning it on changes what every tenant's enabled rules do,
and nobody had seen those rules act on web events before. In production it is
set in `deploy/docker-compose.prod.yml`, on the `app` service's `environment:`
(`AUTOMATION_WEB_EVENTS_ENABLED: "1"`), not in `/opt/inflect/.env.prod`: it is
a non-secret switch, so it belongs in the repo-canonical file, and an
`environment:` entry overrides whatever `env_file:` carries, so a line in
`.env.prod` no longer decides it. It is set on `app` only; the worker never
reads it. It was turned on after these steps, which are also the steps for any
other deployment:

1. Run the `VM check` workflow with the `automation-rules` check. It counts the
   ENABLED rules, per trigger event and per action type, and the tenants that
   hold one. On 2026-11-14 (run 43596452819) it found 0 enabled rules across 0
   tenants, so turning the switch on woke nothing; rules tenants create from
   then on fire from web events.
2. Decide, from those counts, whether the rules that would wake should.
3. Set the switch in the `app` service's `environment:` in the compose file,
   through a pull request (for production, `deploy/docker-compose.prod.yml`).
4. Apply (`VM apply`, action `preflight`, then `apply`), which recreates the
   app with the new environment. Look for `automation-bus.dispatcher_installed`
   with `webEventsEnabled: true` in the app's log.

To turn it off again, remove the line from the compose file in a pull request,
merge, and apply (`preflight`, then `apply`); the next web event is held again. The switch takes effect at the
next event; executions that have already been queued run to completion.

---

## The production VM's Compose file is repo-canonical

`deploy/docker-compose.prod.yml` is the source of truth for the structure of
the production stack on the GCP VM (`inflect-compliance`, `europe-west1-b`,
stack root `/opt/inflect/`). It reaches the host through `deploy/apply.sh`,
and divergence is reported by `deploy/check-drift.sh`.

That contract dates from #2849. Before it, the host file was hand-edited and
the repo copy was hand-edited independently, and the two had diverged by about
148 lines with nothing watching. The hazard was not the divergence itself but
its shape: the repo copy *looked* like the deployable artefact, so someone
recovering under time pressure would have reached for version control and got
a file that had never run.

### The two scripts

| | |
| --- | --- |
| `deploy/apply.sh` | Pushes the canonical set to the VM. Preflights first and stops; `CONFIRM=1` applies. `DRY_RUN=1` validates the repo file locally and contacts no VM at all (usable in CI). `HOST_CONFIG_ONLY=1 CONFIRM=1` pushes only the host config set and reloads its service — it recreates no container, so it needs no service window. `ROLLBACK=1` names the newest compose backup whose content differs from the live file (an apply that changes nothing still backs it up) and validates it; with `CONFIRM=1` it restores it, runs `up -d` and health-verifies. `APPLY_PUBLIC_LOG=1` is for a run whose output is a public log (the `VM apply` workflow): what a tool on the VM prints is reduced to shape. |
| `deploy/check-drift.sh` | Compares repo against VM by sha256. Exit 0 in sync, 1 drift in a file `apply.sh` can push, 2 the VM was unreachable (UNKNOWN — never read as "no drift"), 3 only an `UNRECONCILED` file differs — today just the Caddyfile. |

Run `check-drift.sh` on a weekly cadence so a hand-edit on the VM surfaces in
days rather than during an incident. It runs from an operator's machine or a
cron box, **not** from GitHub Actions: no workflow in this repo authenticates
to GCP (the only secrets any of them reference are `GITHUB_TOKEN` and
`RELEASE_APP_PRIVATE_KEY`), so a scheduled job would fail to reach the VM and
report exit 2 — UNKNOWN — every week. A check that cannot run is worse than
none, because every aggregate scores it green. Scheduling it in CI needs a GCP
service-account or workload-identity secret first.

`apply.sh` recreates containers, so run it in a service window: expect a short
502 on `app` and a Redis restart (AOF-persisted, so queued BullMQ jobs
survive). It health-verifies `/api/readyz` on **both** public origins —
`app.inflect.bg` and the sslip.io host — because Caddy serves two vhosts and
checking one would report the other's outage as a clean deploy. It uses
`/api/readyz` rather than `/api/livez` deliberately: `livez` is
dependency-free and stays green straight through a Redis or database outage,
which is exactly the failure a deploy causes.

### The canonical set is more than the compose file

The compose file bind-mounts three repo-owned files, so a compose file that is
in sync says nothing about what the containers actually mount. `apply.sh`
pushes, and `check-drift.sh` checks, all of:

```
deploy/docker-compose.prod.yml  → /opt/inflect/docker-compose.prod.yml
deploy/init-roles.sh            → /opt/inflect/init-roles.sh
prisma.config.ts                → /opt/inflect/prisma.config.ts
```

`prisma.config.ts` is mounted into both `app` and `worker` at `/app`: Prisma 7
resolves its config at runtime, and the entrypoint runs `prisma migrate deploy`
before `next start`. That mount has been live since the 2026-05-05 Prisma 7
recovery and was absent from the repo file until #2849 reconciled it back.

### And it is more than the compose project: the host config set

Production config that belongs to a **host service** rather than to the
compose project is pushed from a second array, `HOST_CONFIG_SET`:

```
deploy/ops-agent-config.yaml    → /etc/google-cloud-ops-agent/config.yaml
deploy/capacity/recorder/inflect-capacity-record.sh
                                → /usr/local/lib/inflect-capacity/inflect-capacity-record.sh
deploy/capacity/recorder/inflect-capacity-record.service
                                → /etc/systemd/system/inflect-capacity-record.service
deploy/capacity/recorder/inflect-capacity-record.timer
                                → /etc/systemd/system/inflect-capacity-record.timer
```

The set has two owners, decided by each file's remote path
(`host_config_owner` in `apply.sh`): the ops agent, and the capacity recorder
(see "The capacity recorder" below). A path with no owner is refused in
preflight. Each owner brings its own validation and activation, and every
owner is activated on every host-config apply, whichever file changed.

That file is what ships the app container's logs to Cloud Logging. Until it
was versioned it lived **only on the VM** — the last piece of production config
outside git, which is precisely the class of drift #2849 built these two
scripts to eliminate for the compose file. Its failure mode is also the
quietest in the stack: a wrong filter does not break the app, it stops log
export, and an empty log query reads as "a quiet night".

Four properties differ from the compose set, and each is why it is a separate
array rather than a fourth row of the first:

| | compose set | host config set |
| --- | --- | --- |
| remote path | basename under `/opt/inflect` | absolute, outside it |
| activation | `docker compose up -d` | `systemctl restart <unit>` (ops agent); `daemon-reload`, `enable --now` the timer and one pass (recorder) |
| validation | `docker compose config -q` | the service's own engine parses it (ops agent); `bash -n`, `systemd-analyze verify` and one trial pass into a throwaway directory (recorder) |
| service window | yes — a 502 on `app` | **none**; no container is touched |

The last row is why `HOST_CONFIG_ONLY=1 CONFIRM=1 deploy/apply.sh` exists. Were
the two coupled, a logging fix would have to wait for a maintenance window and
a maintenance window would have to carry a logging change — and a mechanism
nobody can afford to run is a mechanism that goes unused, which is how the
original divergence happened.

Two assertions hold the pieces together. `apply.sh` verifies the restart
actually **compiled** the config it just pushed, by looking for the receiver
path in the generated collector config (`systemctl is-active` goes green for an
agent that restarted while keeping its previous pipeline — ops agent 2.72
compiles logging into `otel.yaml`, not into fluent-bit). And
`tests/guards/deploy-canonical-set-is-watched.test.ts` asserts that everything
`apply.sh` pushes is something `check-drift.sh` watches, in both directions: a
file pushed but unwatched drifts silently, and a file watched but unpushed is a
standing warning nobody can action.

### The capacity recorder

Capacity budget step C1b sized `app` and `worker` from their memory peaks
across the 02:00–05:30 UTC nightly chain and the 00:15–01:45 UTC parser window
(`VM capacity` history run 43566712099, 2026-11-14), and tightening the worker
further waits for history that holds a Sunday and a month start. A `VM
capacity` snapshot cannot give those peaks: Watchtower recreates both containers on
every merge to main, which resets their cgroup `memory.peak`, and a snapshot
runs only when the owner approves it, which is never at night. So a timer on
the VM records them (owner decision 2026-11-13).

`inflect-capacity-record.timer` starts `inflect-capacity-record.service` every
10 minutes on the clock. Each pass appends one tab-separated row per running
container to `/var/lib/inflect-capacity/capacity-<UTC day>.tsv`: the time,
the container's name and `StartedAt` (so a restart is visible), and the cgroup
v2 files the snapshot reads — `memory.current`, `memory.peak`, `anon` and
`file` from `memory.stat`, and `usage_usec` from `cpu.stat`. Names and
numbers only: two docker calls per pass, `docker ps` and one `docker inspect`,
each naming the fields it prints; nothing from a container's environment or
command line, and nothing that touches a container. Docker down means a pass
records nothing and exits 0.

It cannot fill the disk. It keeps today and the eight days before it, by the
date in the file name, and refuses to write when the day's file is 4 MiB, when
the directory is 40 MiB, or when the filesystem has under 1 GiB free. A day is
about 0.3 MB at today's container count. The unit runs at `Nice=10`, idle I/O,
`CPUQuota=20%`, `MemoryMax=64M` and a 60-second timeout, with
`NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome` and a private `/tmp`;
its only write is its systemd state directory (root, 0700).

**Installing it** is the host config path: the `VM apply` action
`host-config-preflight`, then `host-config-apply`. The preflight validates the
three files and runs the staged script once against the VM's real cgroups,
into a throwaway directory, and refuses if that pass writes no row — the cgroup
layout is a fact about the host, and a recorder that cannot find it would
write nothing every ten minutes without saying so. The apply pushes the files,
enables the timer, runs one pass and checks for a row. `check-drift.sh` watches
the three files.

**Reading it** is `VM capacity` with `mode: history` and `hours` (1–192,
default 24), which runs `deploy/capacity/history.sh` on the VM. It prints the
window's coverage (first and last row, passes recorded against passes that
fit, and every run of missed passes, so a gap reads as a gap and never as a
quiet night), then per container the peak `memory.current`, the highest
`memory.peak`, peak anonymous memory, restarts seen and average and peak
10-minute CPU in cores, then the same memory figures for each day's parser and
nightly windows with whether `memory.peak` rose inside the window. It reads the
day files only and calls no docker.

**Removing it** is the `VM apply` action `retire-capacity-recorder`: it stops
and disables the timer, removes the unit files, the script and the recorded
rows, and reloads systemd. Then revert its three `HOST_CONFIG_SET` and
`APPLIABLE` entries, or the next host-config apply reinstalls it and
`check-drift.sh` reports the files as absent.

### Interpolation scope is not `env_file`, and the difference bites

Compose interpolates `${VAR}` from the shell environment and from files named
by `--env-file`. A service-level `env_file:` entry is handed to the *container*
and takes no part in interpolation. The two are easy to conflate, so `apply.sh`
always runs compose as:

```bash
docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml up -d
```

| host file | holds | role |
| --- | --- | --- |
| `/opt/inflect/.env` | `POSTGRES_PASSWORD` | interpolation only |
| `/opt/inflect/.env.prod` | `DATA_ENCRYPTION_KEY`, `REDIS_PASSWORD`, the app's runtime config | interpolation **and** the container environment |

Naming `.env.prod` on both sides is deliberate. `app.environment` sets
`DATA_ENCRYPTION_KEY`, and a service-level `environment:` value overrides the
same key coming from `env_file:`. Sourcing the interpolation from the very file
the container reads makes the two agree by construction. Sourcing it from
anywhere else lets compose hand the app a *different* key than `.env.prod`
holds — a failure that surfaces as unreadable ciphertext rather than an error.

Neither host env file is ever written, read for values, or echoed by these
scripts. The preflight checks for the presence of a KEY and prints only
`PRESENT <name>` / `ABSENT <name>`.

### Outstanding operator actions

Two things need an operator, and `apply.sh` refuses to proceed past the first.

1. **`REDIS_PASSWORD` is absent from the host env files.** Redis auth reaches
   the app embedded inside `REDIS_URL`; the compose file needs the credential
   as a standalone variable for `--requirepass` and `REDISCLI_AUTH`. Add
   `REDIS_PASSWORD=` to `/opt/inflect/.env.prod`, set to the credential already
   inside `REDIS_URL` — confirmed byte-identical to the live `--requirepass`
   on 2026-09-24 by comparing digests. These scripts do not write secret files,
   by design; do it by hand. Until then `apply.sh` stops in preflight having
   changed nothing, which is the fail-fast working.

2. **`deploy/caddy/Caddyfile` — CONTENT reconciled 2026-09-26, push still
   blocked.** It used to diverge in both directions: the live copy served a
   second vhost, `app.inflect.bg`, the repo copy did not define, and the repo
   copy carried work the live copy never received. The repo copy is now the
   **superset** — it defines both hostnames through one shared `(app_site)`
   snippet, so a change reaches both names or neither, which is how they drifted
   in the first place. Validated with `caddy validate`, and both configs adapt
   to the same two hostnames.

   One correction to the old note while it was being acted on: it said the live
   copy never received the retry settings. It had them — `lb_try_duration 120s`
   and `lb_try_interval 250ms`. What it genuinely lacked was HTTP/3 and the
   Cache-Control matchers.

   It stays in `UNRECONCILED` and `apply.sh` still does not push it, for a
   MECHANICAL reason rather than a decision: the push loop stages through
   `/tmp/${remote_base}.new.${TS}`, which for a nested path becomes
   `/tmp/caddy/Caddyfile.new.…` — a directory that does not exist on the VM.
   Pushing needs a flattened staging name first, and `apply.sh` is the push
   path for every other canonical file, so that change wants its own diff and
   its own review. Until then the VM keeps its hand-edited copy, which serves
   both hostnames correctly and lacks only HTTP/3 and the cache headers.

### The pipelock overlay

`deploy/docker-compose.pipelock.yml` holds the optional pipelock MCP mediator.
It lived in the canonical compose file until #2849, and that is what made the
canonical file un-runnable: it bind-mounts `./pipelock-signing.key`, which does
not exist on the VM, and Docker responds to a missing bind-mount source by
creating an empty **directory** rather than by failing. `docker compose config`
validates syntax and `env_file:` presence and says nothing about bind-mount
sources, so the service passed every check short of actually starting it.
Enabling pipelock means satisfying the preconditions listed in that file's
header and adding a second `-f` flag.

### The other overlays, and what is not an overlay any more

Two more opt-in overlays add services to the same Compose project on the VM.
Neither is in the canonical set: `apply.sh` does not push them and
`check-drift.sh` does not check them.

| overlay | services | how it reaches the VM |
| --- | --- | --- |
| `deploy/docker-compose.harness-scanner.yml` | `harness-scanner`, `harness-egress` | the `Scanner VM` workflow's `configure` action copies it; `start` runs it |
| `deploy/docker-compose.legacy-mcp-proving.yml` | `legacy-mcp-proving` | the `VM apply` workflow's `recreate-legacy-mcp-proving` action validates, installs and recreates it (or by hand: copy it, then `up -d legacy-mcp-proving` with both `-f` files) |

The OrangeHRM lab overlay (`docker-compose.orangehrm-lab.yml`: `orangehrm`,
`orangehrm-db`, `orangehrm-mcp`) was **retired by owner decision on
2026-11-12** and removed from the repo-canonical set, with its two Caddy vhosts.
Removing it from the running VM is the operator runbook's steps 1–2; until they
run, the three containers and both vhosts keep serving there (the `VM check`
workflow's `containers` check shows which). The repository no longer carries
the overlay; the adapter's source stays in
`deploy/orangehrm-mcp/` for a non-production instance. The operator runbook,
including how to bring it back, is in
[`implementation-notes/2026-11-12-capacity-c1.md`](implementation-notes/2026-11-12-capacity-c1.md).

A Caddyfile push that stops serving a hostname is refused unless the hostname
is named in `CADDY_RETIRE_HOSTS` (space-separated, exact names). A lost
hostname the list does not name is still refused.

### Every service declares a memory limit and a CPU cap

Every service in the canonical file and in the two overlays above declares
`mem_limit` and `cpus` — the service-level keys plain `docker compose` honours,
not `deploy.resources`, which is for swarm. The memory limits together stay at
or under 14.5 GB (host memory minus 1.5 GB), and the batch-shaped services
(`clamav`, `worker`, `harness-scanner`) are capped at one CPU with half the CPU
weight, so the request path keeps a core. `tests/guards/deploy-compose-canonical.test.ts`
holds all of it. The figures, their basis and the risk of an out-of-memory kill
are in [`implementation-notes/2026-11-12-capacity-c1.md`](implementation-notes/2026-11-12-capacity-c1.md);
the `app`, `worker` and scanner limits were re-sized from 24 hours of the
capacity recorder's history, the nightly jobs included, in
[`implementation-notes/2026-11-14-capacity-c1b.md`](implementation-notes/2026-11-14-capacity-c1b.md). The `VM capacity` workflow (below) prints each container's
configured limit, its peak memory and its out-of-memory kills.

`app` and `worker` also state their V8 heap ceiling
(`NODE_OPTIONS: "--max-old-space-size=768"` under a 1024m limit), because a memory limit moves
Node's default heap ceiling to about half the limit. A heap overrun is then a
restart with exit code 134 and `Reached heap limit` in the log, which no
out-of-memory counter records. The guard holds the heap between half and three
quarters of `mem_limit`, so the two move together.

A limit change is a structural change: it reaches the VM through
`CONFIRM=1 deploy/apply.sh` for the canonical file, and through each overlay's
own path for the overlays. A container keeps the limits it was created with
until it is recreated.

### `deploy/.env.prod.example` describes a different deployment

That template describes the Epic OI-1 AWS model — Secrets Manager, RDS,
ElastiCache, resolved by `scripts/bootstrap-env-from-secrets.sh`. The GCP VM
does not use any of it; its secrets live in the two plaintext host files above.
Read the template as documentation of the AWS path, not of this host.

---

## Railway

### Setup

```bash
# 1. Create project on railway.app, connect your GitHub repo
# 2. Railway auto-detects the Dockerfile

# 3. Add a PostgreSQL plugin:
#    Railway dashboard → New → Database → PostgreSQL
#    This provides DATABASE_URL automatically

# 4. Add environment variables in Railway dashboard:
#    AUTH_SECRET, JWT_SECRET, NEXTAUTH_URL, AUTH_URL,
#    GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET,
#    UPLOAD_DIR=/data/uploads, FILE_STORAGE_ROOT=/data/uploads

# 5. Add a persistent volume:
#    Settings → Volumes → Mount path: /data/uploads
```

### Key points

- Railway provides `DATABASE_URL` via the PostgreSQL plugin — **don't set it manually**
- Set `NEXTAUTH_URL` to your Railway-generated domain (or custom domain)
- Volume mount at `/data/uploads` persists uploaded files across deploys
- The Dockerfile entrypoint automatically runs `prisma migrate deploy` on each deploy

### Railway-specific env vars

```
PORT=3000                    # Railway sets this automatically
DATABASE_URL=                # Provided by PostgreSQL plugin
NEXTAUTH_URL=https://your-app.up.railway.app
AUTH_URL=https://your-app.up.railway.app
AUTH_SECRET=<generated>
JWT_SECRET=<generated>
UPLOAD_DIR=/data/uploads
FILE_STORAGE_ROOT=/data/uploads
```

---

## Fly.io

### Setup

```bash
# 1. Install flyctl
curl -L https://fly.io/install.sh | sh

# 2. Launch (uses existing Dockerfile)
fly launch --no-deploy

# 3. Create Postgres cluster
fly postgres create --name inflect-db
fly postgres attach inflect-db

# 4. Create volume for uploads
fly volumes create uploads --size 1 --region your-region

# 5. Set secrets (never in fly.toml)
fly secrets set \
  AUTH_SECRET=$(openssl rand -base64 32) \
  JWT_SECRET=$(openssl rand -base64 32) \
  NEXTAUTH_URL=https://your-app.fly.dev \
  AUTH_URL=https://your-app.fly.dev \
  GOOGLE_CLIENT_ID=xxx \
  GOOGLE_CLIENT_SECRET=xxx \
  MICROSOFT_CLIENT_ID=xxx \
  MICROSOFT_CLIENT_SECRET=xxx \
  UPLOAD_DIR=/data/uploads \
  FILE_STORAGE_ROOT=/data/uploads

# 6. Deploy
fly deploy
```

### fly.toml additions

```toml
[mounts]
  source = "uploads"
  destination = "/data/uploads"

[http_service]
  internal_port = 3000
  force_https = true

[[http_service.checks]]
  grace_period = "30s"
  interval = "15s"
  method = "GET"
  path = "/api/health"
  timeout = "5s"
```

### Key points

- `fly postgres attach` sets `DATABASE_URL` automatically
- Volume mount persists uploads across deploys and restarts
- Secrets set via `fly secrets set` — never committed
- Health check uses `/api/health` (DB connectivity check)

---

## ⚠️ Hosting Considerations

| Provider | File Storage | Recommended |
|----------|-------------|-------------|
| **VPS + Docker Compose** | ✅ Volumes | ✅ Best for this app |
| **Railway** | ✅ Persistent volumes | ✅ Great |
| **Fly.io** | ✅ Mounted volumes | ✅ Great |
| **Vercel** | ❌ Ephemeral filesystem | ❌ Not suitable |
| **Netlify** | ❌ No server | ❌ Not suitable |

This app uses **local file storage** for evidence uploads. Platforms without persistent filesystems (Vercel, Netlify) require migrating to S3/R2 first — that's a separate effort.

---

## Migrations

- Applied via `prisma migrate deploy` (idempotent, safe to re-run)
- **Docker**: Automatic on every container start via `entrypoint.sh`
- **Manual**: `npm run migrate:deploy`
- **Never** use `db push` in production

## Backup & Restore (self-hosted `docker-compose.prod.yml`)

> These commands are for the self-hosted stack in the root
> `docker-compose.prod.yml`, whose database service is `db`. Production runs
> `deploy/docker-compose.prod.yml` instead, and is backed up by the VM's daily
> disk snapshot: see [`docs/disaster-recovery.md`](disaster-recovery.md).

### Database

```bash
# Backup
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U inflect inflect_production > backup_$(date +%Y%m%d).sql

# Restore
docker compose -f docker-compose.prod.yml exec -i db \
  psql -U inflect inflect_production < backup_20240314.sql
```

### Uploads

```bash
# Backup
docker compose -f docker-compose.prod.yml exec app \
  tar czf /tmp/uploads.tar.gz -C /data/uploads .
docker compose -f docker-compose.prod.yml cp app:/tmp/uploads.tar.gz ./uploads_backup.tar.gz

# Restore
docker compose -f docker-compose.prod.yml cp ./uploads_backup.tar.gz app:/tmp/uploads.tar.gz
docker compose -f docker-compose.prod.yml exec app \
  tar xzf /tmp/uploads.tar.gz -C /data/uploads
```

## Security Checklist

- [x] Secrets via env vars only (never in code/config)
- [x] DB not exposed externally (internal Docker network)
- [x] Non-root container user (`nextjs:nodejs`)
- [x] Auth cookies: `httpOnly`, `secure`, `sameSite: lax`
- [x] HSTS + CSP + X-Frame-Options headers
- [x] Rate limiting on auth endpoints, mutations, and tenant-scoped reads — see [rate-limiting docs](rate-limiting.md) for the three-tier design + exclusions
- [x] Test credentials disabled in production
- [x] File upload: mime/size validation + path traversal protection
- [x] PII column-level encryption (AES-256-GCM) — see [encryption docs](encryption-data-protection.md)
- [ ] Volume/disk encryption enabled (self-hosted) — see [encryption docs](encryption-data-protection.md)
- [ ] Backup encryption (GPG) configured — see [encryption docs](encryption-data-protection.md)

---

## Production: one GCP VM

Production is a single GCP VM running the Compose stack in
[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml). How that
file reaches the host is described in
[The production VM's Compose file is repo-canonical](#the-production-vms-compose-file-is-repo-canonical)
above. There is no Kubernetes cluster, Helm chart or Terraform-managed cloud
estate.

This section used to describe one: an EKS path under `infra/helm/inflect/`,
deployed by `.github/workflows/deploy.yml` through staging and production GitHub
Environments, with RDS and S3 backups. None of it ever deployed anything.
`deploy.yml` was removed with the unapplied AWS estate on 2026-09-02 (#2226),
and `infra/helm/` and `infra/terraform/` do not exist.

### How a change reaches the VM

1. A pull request merges to `main` through the merge queue.
2. `.github/workflows/ghcr-publish.yml` builds the image, Trivy-scans it, and
   only on a passing scan pushes it to GHCR as `:latest` and `:sha-<short>`.
   A running publish is never cancelled by the next push (#4280). A push that
   lands while one is building waits, and only the newest waiting push is built.
3. Watchtower on the VM polls `:latest` every 60 seconds and rolls the `app` and
   `worker` containers onto a new image. It updates only those two. A change to
   the stack's structure goes through `deploy/apply.sh`.
4. The `app` container runs `prisma migrate deploy` when it starts
   (`scripts/entrypoint.sh`), so a merged migration applies when the new image
   first starts.

No approval sits between steps 1 and 3. See
[`docs/change-management-policy.md`](change-management-policy.md) and #4056.

### Rolling back

- **The image.** Every published image keeps its `:sha-<short>` tag in GHCR. To
  run a previous image, pin `app` and `worker` to that tag in
  `deploy/docker-compose.prod.yml` and apply it with `deploy/apply.sh`, as for
  any structural change. A pinned tag never moves, so Watchtower finds nothing
  newer for those two services until the pin is removed. Merging a revert also
  works, but builds a new image.
- **The schema does not roll back.** Running an image older than a migration
  runs old code against the new schema, so write migrations
  **expand-and-contract**:
  - **Expand**: add the new column or table, compatible with both versions.
  - **Migrate**: ship the code that uses the new shape.
  - **Contract**: drop the old shape once the new code is stable.

  A rollback past a Contract step loses data, so that pull request should say
  so. A migration that breaks production gets a forward-fix migration.

### Backup, restore and scaling

- **Backup and restore** are the VM's daily disk snapshot, which covers the
  database, evidence uploads and the env file together. The recovery point,
  retention, restore steps and what the snapshot does not protect against are
  in [`docs/disaster-recovery.md`](disaster-recovery.md).
- **Scaling** is vertical: one VM, one `app` container and one `worker`
  container, with no autoscaling. More capacity means a larger machine type.

### Read-only checks without a key

Three dispatch-only workflows reach the VM as the `scanner-vm-operator` service
account, through Workload Identity Federation, so no key exists to leak. Each
runs in the `production` GitHub environment, whose reviewer approves every run.

| Workflow | What it does |
| --- | --- |
| `Scanner VM` (`scanner-vm.yml`) | Configures, checks and starts the harness scanner (`deploy/harness-scanner/README.md`). |
| `VM capacity` (`vm-capacity.yml`) | `mode: snapshot` prints memory, CPU and disk per container now; `mode: history` prints what the capacity recorder wrote over the last `hours` (`deploy/capacity/`). |
| `VM check` (`vm-check.yml`) | Runs one check from a fixed read-only list (`deploy/vm-check/remote.sh`): `containers`, `library-sync`, `log-errors`, `access-review-dates`, `bcrypt`, `automation-rules`. |

`VM check` is how a Claude Code session looks at production without holding a
credential: the session dispatches it, the reviewer approves, and the session
reads the job's output. The service account is root on the VM, so the input is
a choice rather than a command, and a new check is a pull request. The
repository is public, and so are the runs' logs: every check prints names,
states, versions and counts, never a log line, a database row or a credential.
`tests/guards/vm-check-workflow.test.ts` holds these properties.

### Named changes without a key

`VM apply` (`vm-apply.yml`) is the write-side sibling of `VM check`, under the
same identity and the same reviewer (owner decision 2026-11-12). A Claude Code
session that is not signed in to `gcloud` changes production this way:
it dispatches the workflow from `main` with one action, the reviewer approves,
and the session reads the output. The workflow's job-level `if` skips an
unmodified dispatch from any other ref before it asks for approval, because
what it pushes is the checkout and the VM's structure is what merged.

**That `if` is not the security boundary, and neither is the action list.** A
`workflow_dispatch` runs the workflow file and every script it calls from the
ref the dispatcher picks. A branch that deletes the `if`, or rewrites an action
in `deploy/vm-apply/vm.sh`, runs as written, under an identity that is root on
production. The Workload Identity provider admits a token on
`assertion.repository` and `assertion.environment == 'production'` only
(`deploy/harness-scanner/README.md`), not on the ref. So what keeps a branch
off the VM is the `production` environment's protection, and it must be set
this way:

- **Deployment branches: `main` only** (Settings → Environments → production →
  Deployment branches and tags → Selected branches and tags → `main`). A job
  from any other ref then fails before it asks for approval, whatever its file
  says. This is the setting the `if` relies on.
- **Required reviewers.** "Prevent self-review" is **off**, deliberately: a
  session dispatches under the owner's own GitHub account, and the owner is the
  only reviewer, so with it on no run could ever be approved. The approval is
  therefore the owner reading the run, not a second person; a second operator
  would turn it on.
- **The reviewer reads the branch on the pending deployment before approving**,
  and refuses any run not from `main`.

The same holds for `VM check`, `VM capacity` and `Scanner VM`, which take the
same environment and identity.

**As confirmed by the owner on 2026-11-12** (a screenshot of the settings page;
a session cannot read them, because the API path is refused through its proxy),
`production` has **Deployment branches and tags: Protected branches only**, which
applies to one branch, `main`. Two things follow from that setting rather than
from a literal `main`:

- "Prevent self-review" is off (confirmed the same day), for the reason in the
  list above.
- A branch that later gets a branch protection rule becomes deployable to
  `production` too. Keep `main` the only protected branch, or switch the setting
  to *Selected branches and tags* with `main`.
- **Allow administrators to bypass configured protection rules** is on, so an
  administrator can bypass the environment's protection rules. That is the
  owner's own lever, not a path for anyone else.

A second layer is also open: adding
`&& assertion.ref == 'refs/heads/main'` to the provider's attribute condition
would refuse the identity to a branch run even after an approval, and would
limit all four workflows to `main`. It changes a live GCP setting and is the
owner's to make.

| Action | What it runs |
| --- | --- |
| `preflight` | `deploy/apply.sh` (preflight only) |
| `apply` | the preflight, then `CONFIRM=1 deploy/apply.sh` |
| `caddy-preflight` / `caddy-apply` | the same with `CADDY_ONLY=1` |
| `retire-lab-vhosts-preflight` / `retire-lab-vhosts` | the same with `CADDY_RETIRE_HOSTS` set to the OrangeHRM lab's two hostnames, written in `deploy/vm-apply/vm.sh` |
| `host-config-preflight` / `host-config-apply` | the same with `HOST_CONFIG_ONLY=1` |
| `rollback-preflight` / `rollback` | the same with `ROLLBACK=1`: the newest compose backup that differs from the live file, back into service |
| `retire-lab-containers` | `deploy/vm-apply/remote.sh`: `docker compose rm --stop --force` of the lab's three services, volumes kept, never `down` |
| `recreate-legacy-mcp-proving` | `deploy/vm-apply/remote.sh`: checks the bundle and the token are present, validates the repo overlay, keeps the previous one, installs it and recreates that one service |
| `retire-capacity-recorder` | `deploy/vm-apply/remote.sh`: stops and disables the capacity recorder's timer and removes its units, script and rows (installed by `host-config-apply`) |

Every action that writes runs its preflight first in the same run and writes
only if it passed. The input is a choice, never a command, a path, a host or a
compose argument, so a new action is a pull request. The logs are public:
`apply.sh` runs with `APPLY_PUBLIC_LOG=1`, which lets through only the
resource lines `docker compose` prints, the name of a missing variable, and
error lines from caddy and the ops agent (whose only input is a repository
file), and counts the rest as withheld; the remote script prints names,
states, counts and limits. `tests/guards/vm-apply-workflow.test.ts` holds these
properties, and runs the filters on a stream carrying secret-shaped lines.

## Observability provisioning

The telemetry backend (OTel Collector + Prometheus + Tempo + Grafana) is
packaged as a separate Compose project, to run beside the app on the VM:
`docker compose -f infra/observability/docker-compose.observability.yml up -d`.
It is not part of the canonical set above: `deploy/apply.sh` does not push it
and `deploy/check-drift.sh` does not check it. The repository's record of the
running stack, `infra/alerts/gcp-custom-metrics.yml` (verified 2026-09-24),
lists none of its containers and no `OTEL_*` variable on the app, and
production's alerts are the GCP Cloud Monitoring policies in `infra/alerts/`.
See [`docs/observability/03-prometheus-grafana.md`](observability/03-prometheus-grafana.md#where-it-runs).
The app emits OTLP/HTTP, so pointing it at another backend changes only
`OTEL_EXPORTER_OTLP_ENDPOINT` (and its auth header).
[`docs/observability/01-deployment-topology.md`](observability/01-deployment-topology.md#scale-out-provisioning-beyond-the-single-vm)
describes the two other shapes, a dedicated monitoring VM and a managed
backend. Neither is provisioned, and the repository has no Helm chart or
Terraform module for either.

## Registering a sub-processor

When the operator configures an external service (most commonly the SMTP
provider — SES / SendGrid / Postmark), that provider becomes a
sub-processor and MUST be registered in
[`docs/sub-processors.md`](./sub-processors.md) per the
[change policy](./sub-processor-change-policy.md).
