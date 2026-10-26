# Worker scaling

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md).

Production runs one `worker` container under Docker Compose, on the one
production VM ([`docs/deployment.md`](deployment.md)). The `worker` service in
[`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml) has no
replica setting, and nothing scales it. Every background job runs in that one
container.

## What the worker is

- **One container.** It uses the same image as `app`. Its command is
  `node dist/scheduler.mjs && node dist/worker.mjs`: the scheduler registers
  the repeatable jobs in `src/app-layer/jobs/schedules.ts`, and then the BullMQ
  worker (`scripts/worker.ts`) runs until it is stopped.
- **One queue,** `inflect-jobs` (`QUEUE_NAME` in `src/app-layer/jobs/types.ts`).
- **Two limits, both constants in `scripts/worker.ts`:** `concurrency: 5`, and
  a `limiter` of 50 jobs per 60 seconds. No environment variable changes
  either.
- **A health check that needs work to happen.** The compose healthcheck runs
  `dist/worker-healthcheck.mjs`, which reads a heartbeat key that the worker
  refreshes each time it completes a job. A worker that is running but takes no
  jobs reports unhealthy.

## Adding capacity

[`docs/sizing.md`](sizing.md#worker-throughput) has the signals and the first
change for each. In short:

- If more than 50 jobs a minute arrive for a long time, the queue grows
  whatever the machine's size. Raise the `limiter` in code.
- If jobs wait while host CPU is idle, raise `concurrency` in code.
- If jobs wait and host CPU is busy, the machine is the limit. Move to a larger
  machine type.

A second `worker` container would be a change to the compose file, applied with
`deploy/apply.sh`. It would not raise the 50-a-minute limit: BullMQ keeps the
rate limiter in Redis, per queue, so every worker on `inflect-jobs` shares it.
It would also run the scheduler a second time, which registers the same
schedules again; registration is idempotent (`docs/deployment.md`,
"Background worker").

## Restarts and shutdown

The worker stops when Watchtower moves it onto a new image, when
`deploy/apply.sh` recreates it, and when the VM stops. Jobs queued while it is
down wait in Redis, which keeps them on disk (AOF), and run when it is back.

On SIGTERM, `shutdown()` in `scripts/worker.ts`:

1. pauses in-flight agentic runs, so they can resume from their last completed
   step;
2. calls `worker.close()`, which takes no new jobs and waits for the running
   ones;
3. closes the Redis connection and flushes telemetry.

Two things limit what that achieves:

- **About 10 seconds.** The compose file sets no `stop_grace_period` for
  `worker` and no stop timeout for Watchtower, so both use their default of 10
  seconds before they kill the container. A job still running then is killed
  mid-run.
- **A shell is PID 1.** The command runs under `/bin/sh -c`, with node as the
  shell's child. Nothing in the repository shows that the stop signal reaches
  node through that shell. After a restart, look for
  `shutdown signal received` in the worker's log. If it is missing, the worker
  was killed, not shut down.

A job that was killed mid-run is not lost. Its lock expires (30 seconds),
BullMQ's stalled-job check puts it back in the queue, and it runs again from
the start. `scripts/worker.ts` keeps BullMQ's default `maxStalledCount` of 1,
so a job that stalls a second time fails instead of running a third time. A job
that can run twice must be safe to run twice.

## When the queue stops draining

More workers do not help when jobs are not being taken or keep failing: a bug,
a job that fails on every attempt, or a dependency that is down. Find out why
before changing capacity. The production alerts that cover the worker are GCP
Cloud Monitoring policies, listed in
[`infra/alerts/gcp-custom-metrics.yml`](../infra/alerts/gcp-custom-metrics.yml):

- `docker/container_health` reports the worker unhealthy when its heartbeat
  goes stale.
- `jobs/work_overdue` counts rows whose own schedule says they are late.
- `jobs/work_abandoned` counts work given up on in the last 24 hours.

`/api/readyz` does not cover the worker. It checks the web tier's view of the
database and Redis, and stays green while the worker does nothing.

## What was designed and never built

A KEDA `ScaledObject` for the Helm chart (`infra/helm/inflect`) once scaled a
worker Deployment on the length of `bull:inflect-jobs:wait`, from 4 to 50
replicas in `values-production.yaml`. No cluster ever ran it. The chart, its
values files and the guard test for this design were removed with the unapplied
AWS estate on 2026-09-02
([#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226)). The
design is recorded in
[`docs/implementation-notes/2026-06-26-worker-autoscaling.md`](implementation-notes/2026-06-26-worker-autoscaling.md).
