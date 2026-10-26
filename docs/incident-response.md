# Incident Response Runbook

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md) — the developer onboarding guide.

> For the scope of data potentially involved in a breach — which entities hold
> PII, how long each is retained, and the cleanup mechanisms — see
> [`docs/data-retention.md`](data-retention.md).

Production is one GCP VM, `inflect-compliance` in `europe-west1-b`, running the
Compose stack in [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml)
from `/opt/inflect/`. [`docs/deployment.md`](deployment.md) describes how it is
deployed. This runbook is for that VM. There is no Kubernetes, no RDS, no
ElastiCache, no S3 and no PagerDuty.

The services and their containers:

| Service | Container | What it does |
|---|---|---|
| `caddy` | `inflect-caddy-1` | TLS and reverse proxy; the only public ports, 80 and 443 |
| `app` | `inflect-app-1` | Next.js; runs `prisma migrate deploy` when it starts |
| `worker` | `inflect-worker-1` | BullMQ worker and scheduler |
| `pgbouncer` | `inflect-pgbouncer-1` | connection pool in front of Postgres |
| `postgres` | `inflect-postgres-1` | the database (`inflect_compliance`) |
| `redis` | `inflect-redis-1` | job queue, rate limits, cache; `--maxmemory 256mb`, `noeviction` |
| `clamav` | `inflect-clamav-1` | virus scan of uploads |
| `watchtower` | `inflect-watchtower-1` | moves `app` and `worker` onto each new `:latest` image |

If the VM, its disk or its zone is lost, go to
[`docs/disaster-recovery.md`](disaster-recovery.md). Cross-region failover is a
design only, in [`docs/multi-region.md`](multi-region.md).

## On-call

There is no on-call rotation and no pager. Every production alert is a GCP
Cloud Monitoring policy that emails one notification channel
([`infra/alerts/external-uptime.yml`](../infra/alerts/external-uptime.yml),
[`infra/alerts/gcp-custom-metrics.yml`](../infra/alerts/gcp-custom-metrics.yml)).
The uptime alert fires within about six minutes of an outage. How long the
email then waits for a person is not bounded, and no acknowledgement or
response time is committed. An outage at 03:00 waits until someone reads it.

[`docs/change-management-policy.md`](change-management-policy.md#on-call-coverage)
says what that means for changes: out of hours, nobody is assigned to review
or merge, and an emergency fix waits for a reviewer like any other change.

## Getting onto the VM

You need a Google account with access to the VM, and `gcloud` authenticated on
your machine.

```bash
gcloud compute ssh inflect-compliance --zone europe-west1-b
```

Docker commands on the VM need `sudo`. Most steps below use plain `docker`
with the container names above. When you need Compose, run it the way
`deploy/apply.sh` does, naming both host env files. The repository's compose
file reads its secrets from them and refuses to run without them.

```bash
cd /opt/inflect
sudo docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml ps
```

**Things that print secrets. Do not run them:**

- `cat` or `less` on `/opt/inflect/.env` or `/opt/inflect/.env.prod`;
- `cat` on the host's `/opt/inflect/docker-compose.prod.yml`: the host copy
  has carried inline credentials before (#2849);
- `docker compose config` without `-q`;
- `docker inspect` on `app` or `worker` without `--format`: the output
  includes the container's environment.

`deploy/check-drift.sh`, run from your own machine, compares the host's files
with the repository by hash and prints no content.

## Quick reference

Each alert email is titled with the policy's display name.

| You see | Playbook |
|---|---|
| `inflect production is not ready (#2745)` — `/api/readyz` failing from more than one probe region for 5 minutes | [App Down](#1-app-down). The `failed` array in the readyz response names the component. |
| `inflect container unhealthy, or health reporting stopped (#2745)` | `worker`: [Queue Backlog](#4-queue-backlog). `postgres` or `pgbouncer`: [Database](#2-database-unavailable--slow). `redis`: [Redis](#3-redis-oom--degraded-queueing). Any other: [App Down](#1-app-down). If no container is named, the reporter itself stopped: see the alert text. |
| `inflect disk filling — act before postgres cannot write` | [Disk Full](#8-disk-full) |
| `inflect scheduled work is overdue — a job is not doing its job (#3558)` | [Queue Backlog](#4-queue-backlog) |
| `inflect work was ABANDONED — something gave up and nobody was told (#3558)` | [Queue Backlog](#4-queue-backlog), "Abandoned work" |
| `inflect identity writes unsettled — an account is in unknown state (#2842)` | Not a platform fault. Follow the alert text, then the `identity-chain-diagnostic` skill. |
| `inflect assistant is REFUSING most attempts — users blocked from a working feature (#3856)` | Not installed: [`infra/reporters/README.md`](../infra/reporters/README.md) lists its reporter as not deployed. If it is installed and fires, follow the alert text. |
| `inflect agent proposals are FLOODING the review queue (#3856)` | Not installed, as above. |
| Errors start right after a new image reached the VM | [Rollback](#6-rollback) |
| A browser or `curl` rejects the certificate | [Certificate Expiry](#5-certificate-expiry) |
| `OOM command not allowed` in the `app` or `worker` log | [Redis](#3-redis-oom--degraded-queueing) |
| Suspected unauthorised access to data | [Data Breach Response](#7-data-breach-response) |

The Prometheus rules in `infra/alerts/rules.yml` and
`infra/observability/prometheus/rules/` alert nobody in production; see
[`docs/observability/03-prometheus-grafana.md`](observability/03-prometheus-grafana.md).
A name from them (`DatabaseConnectionPoolExhausted`,
`QueueDepthBacklogCritical`, …) did not come from a production alert.

## Severity definitions

The policies carry no severity, and every one sends the same email. The person
responding decides.

| Severity | Means | For example |
|---|---|---|
| **CRITICAL** | Users are getting errors, or data is at risk. | the readyz alert; Postgres down; the disk full; a suspected breach |
| **WARNING** | The product works, but something is degrading or late. | overdue or abandoned work; the disk above 85% |

`docs/slos.md` SLO 7 sets a 4-hour recovery time for a critical incident.

## Dashboards

No Grafana is recorded as running in production
([`docs/observability/03-prometheus-grafana.md`](observability/03-prometheus-grafana.md)).
The places to look are:

- **GCP Monitoring console:** the uptime check `inflect-readyz` and the custom
  metrics under `custom.googleapis.com/` (`docker/container_health`,
  `host/disk_percent_used`, `jobs/work_overdue`, `jobs/work_abandoned`,
  `identity/write_unsettled`).
- **Cloud Logging:** the Ops Agent ships the app's JSON log lines from the
  Docker log files (`deploy/ops-agent-config.yaml`).
- **The VM:** `sudo docker ps`, `sudo docker logs`, `sudo docker stats
  --no-stream`. Each container keeps three 10 MB log files, so a busy
  container's local history is short.
- **The reporters' journals:** for example
  `journalctl -u work-overdue-reporter.service -n 50`
  ([`infra/reporters/README.md`](../infra/reporters/README.md)).

The Grafana dashboards in `infra/dashboards/` and
`infra/observability/grafana/dashboards/` are for the observability stack,
which is not recorded as running.

## Common first steps (every incident)

1. **Write down the time and what you saw**, and post it in the incident
   channel.
2. **Ask the app what is wrong:**
   ```bash
   curl -s https://app.inflect.bg/api/readyz | jq .
   ```
   `failed` lists `database`, `redis` or `storage`. `storage` is skipped in
   production, because evidence is on a local volume.
3. **Check whether a new image just arrived.** Watchtower rolls `app` and
   `worker` onto each image GHCR publishes, within a minute. Each rollout
   takes readyz down for 1–3 minutes, which is why the uptime alert waits 5
   minutes.
   ```bash
   gh run list --workflow ghcr-publish.yml --branch main --limit 5
   # on the VM:
   sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
   sudo docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' inflect-app-1
   sudo docker logs --since 2h inflect-watchtower-1
   ```
4. **Decide between mitigation and investigation:**
   - If it started with a new image, roll back first and investigate after
     ([Rollback](#6-rollback)).
   - If not, investigate, and keep rollback as an option.
5. **Before anything destructive, snapshot the disk.** It holds the database,
   the uploads and the env files, so one snapshot keeps all of them:
   ```bash
   gcloud compute disks snapshot inflect-compliance --zone europe-west1-b \
     --snapshot-names "inflect-incident-$(date -u +%Y%m%d%H%M)"
   ```

---

## 1. App Down

**Trigger:** `inflect production is not ready (#2745)`, or users report the
site is down.

**What it means:** `https://app.inflect.bg/api/readyz` did not return 200 with
`"status":"ready"` from at least two probe regions for 5 minutes. Either the
app cannot serve, or a dependency it checks (Postgres or Redis) is down, or
the path in (DNS, Caddy, TLS) is broken. There is one `app` container and
nothing routes around it, so a failing readyz means users are getting errors.

### Triage

```bash
# 1. From your machine. readyz names the failed dependency; livez answers
#    whenever the process is running.
curl -s https://app.inflect.bg/api/readyz | jq .
curl -s -o /dev/null -w '%{http_code}\n' https://app.inflect.bg/api/livez
```

If the VM does not answer SSH either, check it in the Compute Engine console.
If the VM, its disk or its zone is gone, go to
[`docs/disaster-recovery.md`](disaster-recovery.md).

```bash
# 2. On the VM. Look for Restarting, Exited or (unhealthy).
sudo docker ps -a --format 'table {{.Names}}\t{{.Status}}'
sudo docker inspect --format '{{.Name}} restarts={{.RestartCount}}' inflect-app-1 inflect-postgres-1 inflect-redis-1

# 3. The app's own log.
sudo docker logs --tail 100 inflect-app-1

# 4. Is the app answering inside the VM? Caddy reaches it as app:3000.
sudo docker exec inflect-caddy-1 wget -qO- http://app:3000/api/livez
```

### Decide

| Symptom | Next action |
|---|---|
| `app` restarting, `P3009` in its log | A half-applied migration. [`docs/runbooks/failed-migration-recovery.md`](runbooks/failed-migration-recovery.md). Read all of it first. |
| `app` restarting after a new image arrived | [Rollback](#6-rollback) |
| readyz `failed` includes `database` | [Database](#2-database-unavailable--slow) |
| readyz `failed` includes `redis` | [Redis](#3-redis-oom--degraded-queueing) |
| `No space left on device` in any log | [Disk Full](#8-disk-full) |
| The app answers inside the VM but not from outside | Caddy, DNS or TLS. `sudo docker logs --tail 100 inflect-caddy-1`, then [Certificate Expiry](#5-certificate-expiry). Check that `app.inflect.bg` still resolves to the VM's external address. |
| Containers missing after a reboot | Bring the stack up as defined (next section). |

### Mitigate

- **Restart one container:** `sudo docker restart inflect-app-1`. Use the
  container for the failing service.
- **Bring the whole stack up as defined on the host** (no image or structure
  change):
  ```bash
  cd /opt/inflect
  sudo docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml up -d
  ```
  If it stops with `REDIS_PASSWORD is required`, the host env files lack that
  variable. See "Outstanding operator actions" in
  [`docs/deployment.md`](deployment.md).
- **A bad image:** [Rollback](#6-rollback).

### Verify recovery

- `curl -s https://app.inflect.bg/api/readyz` returns `"status":"ready"`.
- `sudo docker ps` shows every container `Up` and none `(unhealthy)`.
- The alert's incident closes in GCP Monitoring once the check passes again.

---

## 2. Database Unavailable / Slow

**Trigger:** readyz `failed` includes `database`; `postgres` or `pgbouncer`
reported unhealthy; requests time out.

**What it means:** Postgres is down or restarting, the PgBouncer pool is full,
or queries are slow.

### Triage

```bash
# 1. Is Postgres running, and what does it say?
sudo docker ps -a --filter name=inflect-postgres-1 --format '{{.Status}}'
sudo docker logs --tail 100 inflect-postgres-1

# 2. Can it answer? The container trusts its local socket, so no password is needed.
sudo docker exec inflect-postgres-1 psql -U postgres -d inflect_compliance -c 'SELECT 1;'

# 3. PgBouncer pool state. cl_waiting > 0 for long means clients are queueing.
#    POSTGRES_PASSWORD is expanded inside the container and never printed.
sudo docker exec inflect-postgres-1 sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD psql -h pgbouncer -p 5432 -U postgres pgbouncer -c "SHOW POOLS;"'

# 4. What is the database doing? Longest-running statements first.
sudo docker exec inflect-postgres-1 psql -U postgres -d inflect_compliance -c \
  "SELECT pid, now() - query_start AS age, state, left(query, 80) AS query
     FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC LIMIT 10;"

# 5. Is the host short of CPU or memory? No container has a limit.
sudo docker stats --no-stream
```

### Decide

| Symptom | Mitigate |
|---|---|
| `postgres` restarting, `No space left on device` | [Disk Full](#8-disk-full). Postgres restarts by itself once it can write. |
| `postgres` restarting for another reason | Read its log. If it does not come back, see [below](#when-the-database-cannot-be-recovered-on-the-vm). |
| `cl_waiting > 0` for long | The pool is full. Find the long-running statements (step 4). Raising the pool is a compose change applied with `deploy/apply.sh`; see [`docs/sizing.md`](sizing.md#database-connections). |
| One query is slow | Find it in step 4 and look for a missing index. |
| Everything is slow and host CPU is busy | The machine is the limit. A larger machine type needs the VM stopped; see [`docs/sizing.md`](sizing.md#the-machine-type). |

### When the database cannot be recovered on the VM

There is no point-in-time recovery. `archive_mode` is off and there is no WAL
archive or replica. If Postgres cannot be brought back on the VM, the only
recovery is the newest daily disk snapshot, which loses every write since it
was taken (up to 24 hours). Follow
[`docs/disaster-recovery.md`](disaster-recovery.md). It restores the whole
disk, so the uploads and env files come back from the same moment.

Before you restore, snapshot the current disk (step 5 of the common first
steps). It holds the writes the restore will not have.

---

## 3. Redis OOM / Degraded Queueing

**Trigger:** readyz `failed` includes `redis`; `redis` reported unhealthy;
`OOM command not allowed` in the `app` or `worker` log.

**What it means:** Redis is down, restarting, or at its memory cap. It runs
with `--maxmemory 256mb` and `--maxmemory-policy noeviction`, so at the cap it
refuses writes: enqueueing a job fails rather than losing one. Rate limiting
and the cache depend on it too.

### Triage

```bash
# 1. Running? What does it say?
sudo docker ps -a --filter name=inflect-redis-1 --format '{{.Status}}'
sudo docker logs --tail 100 inflect-redis-1

# 2. Memory against the cap. redis-cli reads the password from REDISCLI_AUTH
#    in the container, so it is never on the command line.
sudo docker exec inflect-redis-1 redis-cli INFO memory | grep -E '^(used_memory_human|maxmemory_human)'

# 3. Where the queue's memory is.
sudo docker exec inflect-redis-1 sh -c '
  redis-cli LLEN bull:inflect-jobs:wait
  redis-cli ZCARD bull:inflect-jobs:delayed
  redis-cli ZCARD bull:inflect-jobs:completed
  redis-cli ZCARD bull:inflect-jobs:failed'
```

### Mitigate

| Cause | Action |
|---|---|
| At the memory cap | Raise `--maxmemory` in the `redis` service's `command:` and apply it with `deploy/apply.sh`, if the host has memory to spare ([`docs/sizing.md`](sizing.md#redis-memory)). Applying restarts Redis; the AOF keeps queued jobs. If one queue state holds most of the memory, find out why before raising the cap. |
| Restarting, and its log reports a bad append-only file | The 2026-09-20 outage had this shape: Redis crash-looped for 39 hours on a corrupt AOF. The AOF needs repair with `redis-check-aof`. The repository records no tested procedure for it. Snapshot the disk first. |
| Restarting for another reason | Read the log. A full disk stops AOF writes too: [Disk Full](#8-disk-full). |

### Verify recovery

- readyz no longer lists `redis` in `failed`.
- The `worker` log shows jobs completing, and its healthcheck passes:
  `sudo docker exec inflect-worker-1 node dist/worker-healthcheck.mjs; echo $?`.

---

## 4. Queue Backlog

**Trigger:** `inflect scheduled work is overdue — a job is not doing its job
(#3558)`, `inflect work was ABANDONED — something gave up and nobody was told
(#3558)`, or the `worker` container reported unhealthy.

**What it means:** background work is not happening. Either the worker is
stuck or down, a job fails on every attempt, a dependency is down, or work
arrives faster than the worker's limits allow. `/api/readyz` stays green
through all of these.

### Triage

```bash
# 1. Which rows are late? The reporter's journal names the family.
journalctl -u work-overdue-reporter.service -n 50

# 2. Is the worker alive and taking jobs? Exit 1 means its heartbeat is stale.
sudo docker ps -a --filter name=inflect-worker-1 --format '{{.Status}}'
sudo docker exec inflect-worker-1 node dist/worker-healthcheck.mjs; echo $?

# 3. What is it doing? Look for one job name failing over and over.
sudo docker logs --tail 300 inflect-worker-1

# 4. How deep is the queue? See step 3 of the Redis playbook.
```

### Mitigate

| Cause | Action |
|---|---|
| Worker stuck (stale heartbeat, nothing in the log) | `sudo docker restart inflect-worker-1`. A job killed mid-run goes back on the queue and runs again from the start. |
| One job type fails every attempt | Find the error in the worker log and fix it forward. Restarting does not help. |
| A dependency is down | [Database](#2-database-unavailable--slow) or [Redis](#3-redis-oom--degraded-queueing) first. The queue drains once it recovers. |
| More work than the worker's limits | There is one worker container and nothing scales it. Its limits (`concurrency: 5`, at most 50 jobs a minute) are constants in `scripts/worker.ts`. See [`docs/worker-autoscaling.md`](worker-autoscaling.md). |

**Abandoned work** has used up its retries and will not run again. The
reporter's journal names the family and the error. For abandoned email, one
cause usually explains the whole batch: on 2026-06-03 to 2026-08-31 an SMTP
`550` rejecting the sender domain abandoned 520 notifications. Fix the cause,
then decide which items to send again.

Do not delete keys from Redis by hand to clear the queue. Some jobs are
load-bearing, and a deleted job is gone without a record.

### Verify recovery

- `jobs/work_overdue` returns to 0, and the alert's incident closes.
- The worker's healthcheck passes.

---

## 5. Certificate Expiry

**Trigger:** a browser or `curl` rejects the certificate, or the readyz alert
fires because the check's `ssl_valid` failed.

**What it means:** Caddy obtains and renews Let's Encrypt certificates for
`app.inflect.bg` and the sslip.io fallback name by itself, and keeps them in
the `caddy-data` volume. A certificate that is about to expire means renewal
has been failing. No alert watches the expiry date; the uptime check only
notices once the served certificate is invalid.

### Triage

```bash
# 1. What certificate is being served, and until when?
echo | openssl s_client -servername app.inflect.bg -connect app.inflect.bg:443 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer

# 2. Why is renewal failing? On the VM:
sudo docker logs --since 48h inflect-caddy-1 2>&1 | grep -i -E 'acme|certificate|tls' | tail -50

# 3. Does the name still point at this VM?
dig +short app.inflect.bg
```

### Mitigate

| Cause | Action |
|---|---|
| `app.inflect.bg` no longer resolves to the VM's external address | Fix the DNS record. Caddy retries by itself. |
| Ports 80 or 443 not reachable | Check the VM's network tags and firewall rules in the console. The ACME challenge needs them. |
| Let's Encrypt rate limit | Wait for the limit to reset, as the error message says. |
| Renewal still stuck after the cause is fixed | `sudo docker restart inflect-caddy-1` makes Caddy try again. Restarting keeps the `caddy-data` volume. |

The VM serves its own copy of the Caddyfile. `CADDY_ONLY=1 CONFIRM=1
deploy/apply.sh` pushes the repository's copy and reloads Caddy; see the
header of `deploy/apply.sh`.

### Verify recovery

- `openssl s_client` shows the new dates.
- readyz passes from your machine with normal certificate checks.

---

## 6. Rollback

**Trigger:** errors start right after a new image reached the VM, or another
playbook sends you here.

**What it means:** run a previous image of `app` and `worker` again. Every
published image keeps its `:sha-<short>` tag in GHCR (`ghcr-publish.yml`), so a
rollback needs no rebuild.

### Procedure

```bash
# 1. Which revision is running now?
#    (on the VM)
sudo docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' inflect-app-1

# 2. Which one was before it? A run that succeeded published its commit as the tag
#    sha-<first 7 characters of the commit>.
gh run list --workflow ghcr-publish.yml --branch main --limit 10
```

Then pick one of three ways back. They are the ones
[`docs/change-management-policy.md`](change-management-policy.md) lists.

- **Point `:latest` at the previous image.** Watchtower follows `:latest`, so
  it moves `app` and `worker` back within about a minute. You need push access
  to the package in GHCR.
  ```bash
  docker buildx imagetools create \
    -t ghcr.io/rodnapamet/inflect-compliance:latest \
    ghcr.io/rodnapamet/inflect-compliance:sha-<short>
  ```
  Any push to `main` publishes a new `:latest` and moves production forward
  again (`ghcr-publish.yml` runs on every push to `main`), so land the revert
  or the fix next.
- **Pin the tag in the compose file.** Set `app` and `worker` to
  `ghcr.io/rodnapamet/inflect-compliance:sha-<short>` in
  `deploy/docker-compose.prod.yml` and apply it with `CONFIRM=1
  deploy/apply.sh`. A pinned tag never moves, so Watchtower leaves both alone
  until the pin is removed. `apply.sh` preflights first; while `REDIS_PASSWORD`
  is absent from the host env files it stops there, changing nothing (see
  "Outstanding operator actions" in [`docs/deployment.md`](deployment.md)).
- **Merge a revert.** It goes through the merge queue and builds a new image,
  so it is the slowest. Under the EMERGENCY procedure in
  `docs/change-management-policy.md` it still goes through the queue.

```bash
# 3. Verify, from your machine.
curl -s https://app.inflect.bg/api/readyz | jq .
SMOKE_URL=https://app.inflect.bg node scripts/smoke-prod.mjs
```

### What a rollback changes — and what it doesn't

| ✅ Rolled back | ❌ Not rolled back |
|---|---|
| The `app` and `worker` image | The database schema: migrations that ran stay applied |
| | Data written by the newer image |
| | The host env files, the compose file and the Caddyfile |
| | Anything the newer image sent outside: emails, audit-stream batches, directory writes |

### Migration safety on rollback

The schema does not roll back. The `app` container runs
`prisma migrate deploy` each time it starts, so a merged migration is applied
when the new image first starts, and it stays applied when you run an older
image. The older code then runs against the newer schema.

**Mitigation pattern: expand-and-contract migrations.**

| PR | Schema | App code |
|---|---|---|
| PR1 (Expand) | Add new column / table | Both versions of app work |
| PR2 (Migrate) | (no schema change) | Use the new shape |
| PR3 (Contract) | Drop old shape | Use the new shape exclusively |

A rollback after PR2 (Migrate) is safe — the schema accommodates both. A
rollback after PR3 (Contract) is a data-loss event; **flag it in PR
descriptions so reviewers see the constraint explicitly**.

If you have rolled back past a Contract migration:
1. Roll forward instead, with a fix, if you can.
2. If you cannot, the only way back to the old schema is to restore the disk
   from a snapshot taken before the migration ran
   ([`docs/disaster-recovery.md`](disaster-recovery.md)). Everything written
   since that snapshot is lost.
3. Tell customers the data-loss window.

---

## 7. Data Breach Response

**Trigger:** log review shows unauthorised access, suspicious access patterns,
leaked credentials, a third-party security disclosure, or an anomaly in the
audit log.

**What it means:** confidentiality of customer data may be compromised. Speed
and traceability matter equally.

### Phase 1 — Contain (within 30 minutes)

**1. Preserve evidence first.** The audit log is hash-chained (Epic A.4): do
not change it. Snapshot the disk (common first steps, step 5), then dump the
`AuditLog` table to the VM:

```bash
sudo docker exec inflect-postgres-1 pg_dump -U postgres -d inflect_compliance \
  -t '"AuditLog"' --data-only --column-inserts \
  > "audit-log-incident-$(date -u +%Y%m%dT%H%MZ).sql"
```

The dump holds tenant data. Keep it on the VM, or copy it only to a place with
restricted access. `scripts/verify-audit-chain.ts` recomputes each tenant's
chain and reports any break.

**2. Stop the bleed.** Revoke or rotate whatever was compromised:

| Compromised | Action |
|---|---|
| A user's account or sessions | Revoke the user's sessions on `/admin/members`, or use Revoke All. Deactivate the member if needed. |
| A tenant API key | Revoke it on `/admin/api-keys`. |
| `AUTH_SECRET` | Generate a new one (`openssl rand -base64 32`) and set it in `/opt/inflect/.env.prod`. Every session ends. |
| An OAuth client secret | Rotate it with the provider, then set it in `/opt/inflect/.env.prod`. |
| A Google account or service-account key with access to the project | Disable it in IAM. The project holds the VM and its snapshots. |
| `DATA_ENCRYPTION_KEY` | Do **not** replace it in place. See Phase 4. |

Edit the host env files by hand on the VM, with an editor, without printing
them. A changed `.env.prod` reaches the containers only when they are
recreated:

```bash
cd /opt/inflect
sudo docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml up -d app worker
```

### Phase 2 — Assess (within 4 hours)

| Question | How to answer |
|---|---|
| Which tenants are affected? | Query `AuditLog` for the suspect actor's `userId` / `tenantId` over the relevant window. |
| Which records were accessed? | `AuditLog` rows carry `entity` and `entityId`. Cross-reference them with the actor's window. |
| When did access start? | `AuditLog.createdAt` minimum timestamp for the actor. |
| Is the breach ongoing? | If the credential was rotated in Phase 1: no. Verify with the failed-auth logs since the rotation. |

### Phase 3 — Notify (per regulatory requirement)

| Audience | Channel | Timing |
|---|---|---|
| Internal: leadership + legal | The incident channel, and email | Within 4 hours |
| Affected customers | Email + status page | Per contract (typically within 72h for GDPR-eligible customers) |
| Regulator (if required) | Per jurisdiction (GDPR Art. 33: 72h to supervisory authority) | Per regulatory clock |

Use the [communication templates](#communication-templates) below.

### Phase 4 — Recover

- Rotate every secret the attacker could have read: the app's secrets, OAuth,
  the database password, the Redis password and the encryption key.
- For `DATA_ENCRYPTION_KEY` specifically: follow the Epic B v1→v2 sweep
  procedure in [`docs/epic-b-encryption.md`](epic-b-encryption.md) ("Rotating
  keys safely" and "Key-compromise incident response"). Deploy the new key as
  `DATA_ENCRYPTION_KEY` and the old one as `DATA_ENCRYPTION_KEY_PREVIOUS`, then
  run the sweep. **Do NOT regenerate the KEK without the sweep** — encrypted
  data becomes unrecoverable. The host env file is the key's only copy, and
  the disk snapshots hold the old one.
- Audit access to the breach vector before re-enabling it.

### Phase 5 — Post-mortem

Within 7 days:
- Root cause narrative (5 whys)
- Timeline (detection → containment → recovery)
- Customer-impact assessment
- Remediation tracker (each finding → ticket → owner → due date)
- Filed in `docs/post-mortems/<YYYY-MM-DD>-<short-title>.md`

---

## 8. Disk Full

**Trigger:** `inflect disk filling — act before postgres cannot write` (the
root filesystem above 85% for 5 minutes), or `No space left on device` in a
log.

**What it means:** one disk holds the OS, the images, the database, Redis, the
uploads and the logs. On 2026-09-24 it reached 100%: Postgres could not write
its WAL and crash-looped eight times, and readyz went down with it. 14 GB of it
was old images from registry paths Watchtower no longer manages.

### Triage

```bash
df -h /
sudo docker system df          # "reclaimable" is usually the answer
sudo docker images             # look for images from old registry paths
sudo du -xh --max-depth=1 / | sort -rh | head
```

### Mitigate

- Remove images no container uses: `sudo docker rmi <image>`, or
  `sudo docker image prune` for dangling ones.
- Never delete files under a Docker volume by hand, least of all the Postgres
  or Redis data.
- If nothing can be freed, grow the disk:
  ```bash
  gcloud compute disks resize inflect-compliance --zone europe-west1-b --size <GB>
  ```
  The filesystem then has to be grown on the VM. Check the device and the
  filesystem type with `lsblk` and `df -T /` first.

### Verify recovery

- `df -h /` is below 85%, and the alert's incident closes.
- Postgres and Redis are `Up` and readyz passes.

---

## Communication templates

### Alert email (GCP Monitoring)

GCP Monitoring puts the policy's `documentation` field from
`infra/alerts/policies/*.json` into the email. To change what the email says,
change the policy file in the repository and update the deployed policy from
it. An edit made only in the console leaves the repository describing a
policy that no longer exists.

### Status page update — initial

```
[INVESTIGATING] We are investigating reports of <symptom> affecting
<service / endpoint>. Customers may experience <observable impact>.
We will provide an update within 30 minutes.

Posted at <UTC time>.
```

### Status page update — mitigation in progress

```
[IDENTIFIED] We have identified the cause as <root cause description>
and are <action taken>. We expect resolution within <time>.

Posted at <UTC time>.
```

### Status page update — resolved

```
[RESOLVED] At <UTC time>, the issue affecting <service> was
resolved. Cause: <one-line summary>. We will publish a detailed
post-mortem within 7 days.

Total customer-visible impact window: <start UTC> to <end UTC>
(<duration> total).
```

### Internal Slack — incident channel kickoff

```
🚨 INCIDENT: <short-title>

- Severity: <CRITICAL | WARNING>
- Started: <UTC time> (per <alert name>)
- IC: <name>     SME: <name>     Comms: <name>
- Affected service: <service>
- Initial symptom: <one-liner>
- Runbook: docs/incident-response.md#<section>

Posting commentary every 15 minutes here.
```

### Customer email — service degradation

```
Subject: [Inflect Compliance] Service incident notification — <date>

Dear <Customer>,

We are writing to inform you of a service incident that began at
<UTC time> and was resolved at <UTC time>. During this window:

- Affected functionality: <description>
- Customer-visible impact: <description>
- Data integrity: <Confirmed unaffected | Under investigation>
- Remediation taken: <one-line summary>

A detailed post-mortem follows at <link> within 7 days. <!-- docs-accuracy-allow: customer-comms template, future-tense is intentional -->


We apologise for the disruption. Please reach out to
support@inflect-compliance.example.com if you have questions.

— The Inflect Compliance team
```

### Customer email — confirmed data breach

(For data-breach incidents only. Coordinate with legal before
sending — wording may need to be adjusted for the specific
regulatory regime.)

```
Subject: [Inflect Compliance] Important: Security incident affecting your data

Dear <Customer>,

We are writing to inform you of a security incident that has
affected data associated with your Inflect Compliance account.

What happened:
  <Brief factual summary of the incident, no speculation.>

When it happened:
  <UTC start> to <UTC end>.

What information was involved:
  <Specific data types — be precise. Don't say "personal data";
   say "user names, email addresses, and audit log entries from
   period X to Y".>

What we have done:
  - <Containment action>
  - <Affected credentials rotated>
  - <Forensic preservation>

What you should do:
  - <Specific recommendation, e.g. "rotate any passwords reused
     across services">
  - <Watch for suspicious activity>

Regulatory notifications:
  Per <GDPR Art. 33 / state breach notification law / etc.>, we
  have notified <regulator>. <Other notification details.>

For questions, please contact security@inflect-compliance.example.com
or your account manager.

— The Inflect Compliance team
```

---

## Operational alignment summary

What this runbook relies on, and where each piece is defined:

| Runbook step uses... | ...which is defined in |
|---|---|
| The services and container names | `deploy/docker-compose.prod.yml` (the compose project in `/opt/inflect/`) |
| Pushing a compose change; the drift check | `deploy/apply.sh`, `deploy/check-drift.sh` ([`docs/deployment.md`](deployment.md)) |
| A new image reaching the VM | `.github/workflows/ghcr-publish.yml` and the `watchtower` service |
| The uptime alert on `/api/readyz` | `infra/alerts/external-uptime.yml`, `infra/alerts/policies/readyz-uptime.json` |
| The custom-metric alerts | `infra/alerts/gcp-custom-metrics.yml`, `infra/alerts/policies/`, `infra/reporters/` |
| `/api/readyz` and `/api/livez` | `src/app/api/readyz/route.ts`, `src/app/api/livez/route.ts` |
| The worker's healthcheck | `scripts/worker-healthcheck.ts`, bundled as `dist/worker-healthcheck.mjs`; see [`docs/worker-autoscaling.md`](worker-autoscaling.md) |
| Restoring from a snapshot | [`docs/disaster-recovery.md`](disaster-recovery.md) |
| A half-applied migration | [`docs/runbooks/failed-migration-recovery.md`](runbooks/failed-migration-recovery.md) |
| Audit log integrity (hash-chained) | Epic A.4; `scripts/verify-audit-chain.ts` |
| Encryption-key rotation | Epic B; [`docs/epic-b-encryption.md`](epic-b-encryption.md) |

---

## Revision history

| Date | Change |
|---|---|
| 2026-04-27 | Initial runbook (Epic OI-3 final layer). 7 playbooks + 5 communication templates. Written for an EKS/RDS estate (Terraform, Helm, PagerDuty) that was never provisioned. |
| 2026-09-02 | A table at the top translated the EKS/RDS commands for the GCP VM, after the estate was removed (#2226). |
| 2026-10-26 | Rewritten for the GCP VM (#4308): every playbook uses the VM's containers, the alerts are the GCP Monitoring policies that exist, the on-call section says there is no rotation, and a Disk Full playbook is added. |
