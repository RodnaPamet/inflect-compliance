# Production Sizing Playbook

Production is one GCP VM running the Compose stack in
[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml). It runs
one `app` container and one `worker` container. Nothing autoscales. More
capacity means a larger machine type, or a setting changed in that compose file
and applied with `deploy/apply.sh`. [`docs/deployment.md`](deployment.md)
describes how the VM is deployed.

This doc lists what shares the machine, which settings bound its capacity, the
signal that says each one is short, and what to change first.

> **What is measured.** No load test has been run against the production VM,
> so this doc gives no capacity figure for it. The only load data in the repo
> is the nightly k6 smoke ([below](#the-k6-baseline)). It runs on a CI runner,
> without most of the production stack, and as of 2026-10-25 it crosses its own
> thresholds. Where the repo has no figure, this doc says what to measure.

## What runs on the VM

The services in `deploy/docker-compose.prod.yml`:

| Service | Image | Role | Limits set in the compose file |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS and reverse proxy. Publishes the only host ports, 80 and 443. | none |
| `app` | `ghcr.io/rodnapamet/inflect-compliance:latest` | Next.js web server. Runs `prisma migrate deploy` when it starts. | none |
| `worker` | the same image | BullMQ worker and scheduler (`scripts/worker.ts`, `scripts/scheduler.ts`). | none |
| `pgbouncer` | `edoburu/pgbouncer:latest` | Transaction-mode pool between `app`/`worker` and Postgres. | `DEFAULT_POOL_SIZE` 25, `MAX_DB_CONNECTIONS` 50, `MAX_CLIENT_CONN` 200 |
| `postgres` | `postgres:16-alpine` | The database. | none; `max_connections` is not set |
| `redis` | `redis:7-alpine` | BullMQ job queue, rate limits, cache. AOF persistence on. | `--maxmemory 256mb`, `--maxmemory-policy noeviction` |
| `clamav` | `clamav/clamav:1.4` | Virus scan of uploaded files. | none |
| `watchtower` | `containrrr/watchtower:latest` | Rolls `app` and `worker` onto a new image. | none |

Four more things share the machine:

- **No service sets `mem_limit`, `cpus` or `deploy.resources`.** Every
  container draws on the whole VM, so one busy container slows the others. When
  memory runs out, the kernel picks which process to kill.
- **The observability stack** is packaged as a separate Compose project to
  run on the same VM (`infra/observability/docker-compose.observability.yml`).
  The repository's record of the running stack lists none of its containers
  ([`docs/observability/03-prometheus-grafana.md`](observability/03-prometheus-grafana.md#where-it-runs)).
  Where it runs, its four containers carry caps: collector 512 MB / 1 CPU,
  Prometheus 1 GB / 1 CPU, Tempo 1 GB / 1 CPU, Grafana 512 MB / 0.75 CPU. See
  `docs/observability/01-deployment-topology.md`.
- **Opt-in overlays** in `deploy/` (`docker-compose.pipelock.yml`,
  `docker-compose.orangehrm-lab.yml`, `docker-compose.legacy-mcp-proving.yml`,
  `docker-compose.harness-scanner.yml`) add services to the same VM when an
  operator starts them. Count them in when they are running.
- **One disk holds everything**: the OS, Docker images, the Postgres and Redis
  data, evidence uploads, container logs and the observability volumes. Each
  container's log is capped at three 10 MB files (`x-logging` in the compose
  file). The disk's size and backups are in
  [`docs/disaster-recovery.md`](disaster-recovery.md).

## The machine type

The VM was an `e2-highmem-2` (2 vCPUs, 16 GB) when that was recorded on
2026-10-12, in
[`docs/legacy-access-recertification-design.md`](legacy-access-recertification-design.md).
Nothing in this repository sets the machine type. Check the current one in the
Compute Engine console before planning.

A larger machine type gives every container more CPU and memory at once,
because none of them is capped. Changing it needs the VM stopped, which stops
the whole stack rather than restarting `app`, so it needs a service window. The
containers start again on boot (`restart: unless-stopped`). Take a manual disk
snapshot before the stop.

## Signals and what to change first

Find the constraint before changing anything. Each change below fixes one kind
of shortage and does nothing for the others.

| Signal | Where to read it | First change |
|---|---|---|
| Host CPU or memory near its limit | `sudo docker stats --no-stream` on the VM; the VM's CPU graph in the Compute Engine console | A larger machine type. |
| API p95 near the SLO: reads 500 ms, writes 1000 ms (`docs/slos.md`, SLO 2 and 2b) | Recording rule `job:api_request_duration_ms:p95`; alert `ApiLatencySloBreach` (p95 above 750 ms for 15 minutes); the `inflect-api-overview` dashboard | If host CPU is high, a larger machine type. If it is not, find the slow route or query first. |
| Clients waiting for a database connection | PgBouncer's admin console (`SHOW POOLS`, the `cl_waiting` column); one stats line a minute in the `pgbouncer` log (`STATS_PERIOD: 60`) | [Raise the PgBouncer pool](#database-connections), within Postgres `max_connections`. |
| Jobs waiting | `job_queue_depth{queue_state="waiting"}`; alert `JobQueueDepthGrowing` (above 500 and growing for 20 minutes); the `inflect-jobs-and-queues` dashboard | See [worker throughput](#worker-throughput). |
| Redis near 256 MB, or `OOM` errors in the `app` or `worker` log | `redis-cli INFO memory` (`used_memory` against `maxmemory`) | [Raise `--maxmemory`](#redis-memory), if the host has memory to give. |
| Disk filling | `df -h` on the VM | A larger disk. |

The metric names come from `infra/observability/prometheus/rules/` and the
dashboards from `infra/observability/grafana/dashboards/`. The alerts and
dashboards are described in `docs/observability/03-prometheus-grafana.md`.
They exist only where the observability stack runs, and the repository's
record of production lists no such stack; production's alerts are the GCP
Cloud Monitoring policies in `infra/alerts/policies/`.

Every setting below is in `deploy/docker-compose.prod.yml` or in source. A
change is a pull request, then `deploy/apply.sh` (`CONFIRM=1` applies) for a
compose change, or a merge for a source change. `apply.sh` recreates
containers, so run it in a service window.

### Database connections

- The `app` and the `worker` each hold a node-postgres pool of up to
  `DB_POOL_MAX` (25) connections to PgBouncer. It is a constant in
  `src/lib/db/concurrency-limits.ts`, which explains why it is 25. A second
  pool of the same size exists when `DATABASE_READ_URL` is set.
- PgBouncer runs in transaction mode. It maps those clients onto at most
  `DEFAULT_POOL_SIZE` (25) server connections per database and user pair, and
  at most `MAX_DB_CONNECTIONS` (50) to the database in total. It accepts at most
  `MAX_CLIENT_CONN` (200) clients.
- The compose file does not set Postgres's `max_connections`, so it is the
  value `initdb` chose. Read it with `SHOW max_connections`. Connections made
  through `DIRECT_DATABASE_URL`, which bypasses PgBouncer, count against it
  too.

To raise the pool, edit the `pgbouncer` environment in the compose file. Keep
`MAX_DB_CONNECTIONS` plus any direct connections below `max_connections`.
Going past `max_connections` also needs a change to the `postgres` service.

### Worker throughput

One `worker` container runs every background job. Its BullMQ settings are
constants in `scripts/worker.ts`: `concurrency: 5`, and a `limiter` of 50 jobs
per 60 seconds. No environment variable changes either.

- If more than 50 jobs a minute arrive for long, the queue grows whatever the
  machine's size. Raising the limiter is a code change.
- If jobs wait while host CPU is idle, raise `concurrency`, also in code.
- If jobs wait and host CPU is busy, the machine is the constraint.

The compose file defines one `worker` and has no replica setting.

### Redis memory

`redis` runs with `--maxmemory 256mb` and `--maxmemory-policy noeviction`. At
the cap Redis refuses writes with an `OOM` error rather than dropping keys, so
an enqueue fails loudly instead of losing a job. `docs/deployment.md`, section
"Redis — eviction policy", explains why. Raise `--maxmemory` in the `redis`
service's `command:`. Applying it restarts Redis; the AOF keeps queued jobs.

## Load tiers

The four tiers are load bands, each paired with the change that serves it.
Only the first rests on a measurement, and that measurement is the CI smoke,
not the VM.

| Tier | Load | What serves it | Provenance |
|------|------|----------------|------------|
| **small** | Up to the smoke's 25 concurrent virtual users | Today's VM and compose settings | observed¹ |
| **medium** | More than that, while today's machine type stays within the SLOs | Today's VM, with whichever setting its signal names | extrapolated² |
| **large** | More than today's machine type carries | A larger machine type, same compose file | extrapolated² |
| **enterprise** | More than one VM carries | Nothing in this repository: the stack is one Compose project on one host | extrapolated² |

¹ **observed** — the nightly smoke runs at this concurrency, on a CI runner
rather than the VM. `src/lib/db/concurrency-limits.ts` sizes the database pool
to it. Its recent runs do not show this tier healthy; see below.
² **extrapolated and untested** — no load test has measured where one band
ends and the next begins.

<!-- sizing-provenance
small: observed — nightly k6 smoke at 25 VUs via load-test.yml, on a GitHub-hosted runner, not on the VM; crossing its own thresholds in every run checked from 2026-09-26 to 2026-10-25
medium: extrapolated — untested; today's VM with setting changes; where the band ends is unmeasured
large: extrapolated — untested; a larger machine type running the same compose file
enterprise: extrapolated — untested; more than one VM; no deployment shape for it in this repo
-->

## The k6 baseline

`tests/load/` holds three k6 scenarios: `auth.js`, `lists.js` and
`mutations.js`. `tests/load/README.md` documents them, and `docs/slos.md` maps
them to the SLOs. `.github/workflows/load-test.yml` runs `auth.js` and
`lists.js` every night at 25 virtual users for one minute of steady state. It
can also be started by hand with another scenario, VU count and duration.

Three things limit what it says about production:

- **It is not the production stack.** It runs on a GitHub-hosted
  `ubuntu-latest` runner, against `next start`, with Postgres and Redis as
  service containers. There is no PgBouncer, worker, ClamAV or Caddy, and
  nothing else shares the machine.
- **A green run proves nothing.** Each k6 step is `continue-on-error`, so the
  run succeeds whatever the thresholds say. Read the results in the job log or
  in the `k6-results-<run id>` artifact, which is kept for 7 days.
- **It is failing its thresholds.** The runs of 2026-09-26, 2026-10-11 and
  2026-10-25 all crossed them. The login step's p95 was 7.3 to 8.5 s against a
  1.5 s threshold, and about 99.7% of the list requests in `lists.js` failed
  (`list_success_rate` about 0.3%).

The smoke's thresholds are wider than the SLOs on purpose: `p(95)<800` ms for
list reads, against the 500 ms read SLO. A capacity figure for the VM needs a
run against the VM's own stack, at rising VU counts, with a warm-up, while
watching the signals above. Tenants load the system in different ways, so
re-measure when the mix of tenants changes.
