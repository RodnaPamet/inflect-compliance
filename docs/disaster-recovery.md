# Disaster Recovery

Production is a **single GCP VM** (`inflect-compliance`, `europe-west1-b`,
project `hazel-design-419410`) running Docker Compose. The DR posture is
therefore simple to state: **one daily crash-consistent snapshot of the one
disk everything lives on**, plus a human-driven restore.

> **Honest scope.** This is NOT warm standby, NOT a read replica, NOT
> active-active, and NOT cross-region in the failover sense. It buys: *if the
> disk or the zone is lost, we can rebuild in another zone in 2–4 hours, losing
> at most the last 24 hours of writes.* See
> [What this does NOT protect against](#what-this-does-not-protect-against).

## DR posture: daily disk snapshot

| | |
|---|---|
| **RPO (data loss)** | **24h.** Policy `inflect-daily-snapshot` takes one snapshot per day at 02:00 UTC. There is no PITR: `archive_mode=off` and `pg_stat_archiver.archived_count` is 0 for the container's lifetime, so there is no WAL chain to roll forward. The recovery point is always the last completed snapshot. |
| **RTO (time to restore)** | **~2–4h**, and **never performed under incident conditions.** Create a disk from the snapshot, attach it to a VM, restore `/opt/inflect/`, bring the Compose stack up, verify. |
| **Retention** | `maxRetentionDays: 14`, plus one permanent manual snapshot (`inflect-manual-20260801-192003`) which is user-created and therefore exempt from the reap. |
| **Geography** | `storageLocations: [eu]` — the EU multi-region. A snapshot survives loss of `europe-west1-b` and of the disk. `onSourceDiskDelete: KEEP_AUTO_SNAPSHOTS`. |
| **Consistency** | `guestFlush: false` — **crash-consistent, not application-consistent.** The filesystem is not quiesced; Postgres replays WAL on start. Observed to work: see the restore evidence below. |
| **Coverage** | Database, evidence uploads (`STORAGE_PROVIDER=local`, on a Docker volume) and `/opt/inflect/.env.prod` are all on that one 50 GB disk, so one snapshot covers all three. That is also the single point of failure. |
| **Cost** | Snapshot storage only. |

### Restore evidence

The drill that exercises this **lives in another repository** —
`RodnaPamet/agri-saas`, workflow `restore-test.yml`, matrix leg
`Restore Test (inflect-compliance)`. It restores the newest READY snapshot of
disk `inflect-compliance` to a temporary disk and validates it.

| Date | Trigger | Result |
|---|---|---|
| 2026-08-01 | manual | restored |
| 2026-08-21 | `workflow_dispatch` | passed |
| 2026-09-01 | `workflow_dispatch` | passed — Postgres up after 2 s WAL recovery, 258 migrations, 167 `tenant_isolation` policies, `app_user` present |
| 2026-10-03 | not recorded in this repo | passed — the newest success `restore-drill-freshness.yml` reported on 2026-10-19 |

> **⚠ No SCHEDULED run has succeeded.** The first three runs were started by
> hand. The 2026-09-01 scheduled attempt died on `ZONE_RESOURCE_POOL_EXHAUSTED`,
> and a zone fallback was added upstream after it. On 2026-10-19,
> `.github/workflows/restore-drill-freshness.yml` in this repo still warned
> that no scheduled run of the drill had succeeded. That check runs weekly and
> fails if no successful run lands within 45 days.

The drill covers the disk restore and the database check. It does not create a
VM, start the Compose stack or move DNS, so the
[runbook below](#runbook-the-vm-its-disk-or-its-zone-is-lost) has never been
run end to end.

### What was designed and never built

An AWS cross-region snapshot-copy DR posture was designed for this product —
EventBridge on snapshot creation, a Lambda copying to a second region under a
multi-region CMK, a retention Lambda pruning old copies. **It was never
applied.** Every `terraform apply` run failed (13 attempts, 0 successes, no
state file, no configured credentials), and the design was `count`-gated off by
default (`db_dr_region = ""` → zero DR resources) even in intent. There is no
RDS, no S3 and no cross-region copy in the recovery path. Do not plan against
it; see [#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).

## What this does NOT protect against

- **Up to 24 hours of writes.** Everything written after the last snapshot is
  lost with the disk or the zone. There is no WAL archive to replay and no
  replica. The ways to shrink that window are in
  [the DR ladder](#the-dr-ladder); none is built.
- **Loss of the GCP project.** The snapshots are in the same project as the VM,
  so a project-level loss or compromise reaches both. No copy of the data is
  kept outside the project.
- **Loss of `DATA_ENCRYPTION_KEY`.** Its only copy is in
  `/opt/inflect/.env.prod`, on the same disk. A snapshot taken before the loss
  is the only way back (`docs/slos.md`, SLO 7).
- **Redis state.** Redis's AOF is a Docker volume on the same disk, so a
  restore brings Redis back as it was at snapshot time. Jobs enqueued after the
  snapshot are gone. Jobs that were queued at snapshot time can run again,
  including ones that had already run before the outage. Rate-limit counters
  roll back too.
- **Effects outside the VM.** Emails sent, audit-stream batches delivered to
  tenants' SIEMs and identity-directory writes made after the snapshot stay
  done. The restored database has no record of them, and a job that runs again
  can repeat them.
- **Evidence uploads.** They are on the same disk (`STORAGE_PROVIDER=local`),
  so they share the snapshot's recovery point. There is no object store and no
  separate copy.

## Runbook: the VM, its disk or its zone is lost

> Written for an on-call engineer doing this for the first time. It needs a
> Google account with Compute Engine admin rights on project
> `hazel-design-419410`, and `gcloud` authenticated on an operator's machine.
> Run the commands from the repository root and replace every `<...>`. The
> whole runbook has never been run (see [Restore evidence](#restore-evidence)),
> so write down anything that differs.

```bash
PROJECT=hazel-design-419410
gcloud config set project "$PROJECT"   # deploy/apply.sh and deploy/check-drift.sh read the project from here
ZONE=<a zone that is up>               # chosen in step 2
```

### 0. Restore, or wait?

Restore only if all of these hold. Otherwise wait.

- The VM, its disk or `europe-west1-b` is down, confirmed in the Compute
  Engine console or on Google Cloud's service health page, and recovery is more
  than 2 hours away or unknown.
- `/api/readyz` has failed for more than 15 minutes, and the cause is not a
  deploy or a config change. A bad image is a rollback (`docs/deployment.md`,
  "Rolling back"), not a restore.
- The on-call lead has approved the restore in the incident channel. Record the
  decision and the time.

If the disk survives, waiting for the zone loses no data. A restore loses every
write since the snapshot it starts from.

### 1. Find the newest snapshot

```bash
gcloud compute snapshots list --project "$PROJECT" \
  --filter="sourceDisk~inflect-compliance AND status=READY" \
  --sort-by=~creationTimestamp --limit=3 \
  --format="table(name,creationTimestamp,sourceDisk.basename(),status)"
```

Take the newest one whose source disk is `inflect-compliance`. It should be
less than about 24 hours old. If the newest is older than 36 hours, the
schedule has stopped; that snapshot is still the best recovery point there is,
so record its age in the incident channel. Its `creationTimestamp` is the
recovery point: everything written after it is lost.

### 2. Create a disk from it in another zone

Choose the zone:

- **Zone lost:** another zone of `europe-west1`, i.e. `europe-west1-c` or
  `europe-west1-d`.
- **Region lost:** a zone in another EU region. The snapshots are stored in the
  `eu` multi-region. `docs/sub-processors.md` names `europe-west1` as the
  hosting region, so a move to another region is recorded there.

```bash
SNAPSHOT=<name from step 1>
DISK=inflect-compliance-restore-$(date -u +%Y%m%d)

gcloud compute disks create "$DISK" --project "$PROJECT" --zone "$ZONE" \
  --source-snapshot "$SNAPSHOT"
```

Add `--type <type>` to match the lost disk's type, which the console shows.

### 3. Create a VM on that disk

The disk is a boot disk. It holds the OS, Docker, the Ops Agent, `/opt/inflect/`
and every Docker volume.

```bash
gcloud compute instances create inflect-compliance-restore \
  --project "$PROJECT" --zone "$ZONE" \
  --machine-type <the lost VM's machine type> \
  --disk "name=$DISK,boot=yes,auto-delete=no"
```

Give the new VM what the lost one had. Read it from the console, or with
`gcloud compute instances describe inflect-compliance --zone europe-west1-b`
if the API still answers for it:

- **Network tags** (`--tags`), so the firewall rules that admit ports 80 and
  443, and SSH through IAP, apply to it.
- **Service account and scopes** (`--service-account`, `--scopes`), so the Ops
  Agent can write to Cloud Logging.
- **External address.** The VM gets a new address unless a reserved static
  address that is free in the same region is attached (`--address`). Plan for a
  new one.

### 4. Check that the stack came up

The restored disk carries `/opt/inflect/` as it was at snapshot time: the
compose file, both host env files and the volumes. Docker starts on boot and
every service is `restart: unless-stopped`, so the stack that was running at
snapshot time starts again by itself. Postgres replays its WAL first.

```bash
gcloud compute ssh inflect-compliance-restore --zone "$ZONE" --tunnel-through-iap \
  --command "sudo docker ps --format '{{.Names}}\t{{.Status}}'"
```

Expect the eight services of `deploy/docker-compose.prod.yml`, plus the
observability stack's four if it was running. `worker` reports `healthy` only
after its 300-second start period. If a service is missing, start the stack
with the command `deploy/apply.sh` itself uses:

```bash
gcloud compute ssh inflect-compliance-restore --zone "$ZONE" --tunnel-through-iap \
  --command "cd /opt/inflect && sudo docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml up -d"
```

### 5. Repoint DNS

Point the A record for `app.inflect.bg` at the new VM's external address. The
record is held by the DNS provider for `inflect.bg`; nothing in this repository
manages it.

```bash
gcloud compute instances describe inflect-compliance-restore --zone "$ZONE" \
  --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```

Caddy's certificate for `app.inflect.bg` is in the restored `caddy-data`
volume, so TLS works as soon as the record resolves to the new address. The
`*.34-140-180-255.sslip.io` hostnames in `deploy/caddy/Caddyfile` encode the old
address and no longer reach this VM.

Sign-in redirects follow `NEXTAUTH_URL` and `AUTH_URL`. If either names an
sslip.io host, OAuth sign-in breaks until it names `app.inflect.bg`. This counts
the matching lines without printing a value:

```bash
gcloud compute ssh inflect-compliance-restore --zone "$ZONE" --tunnel-through-iap \
  --command "sudo grep -cE '^(NEXTAUTH_URL|AUTH_URL)=.*sslip' /opt/inflect/.env.prod"
```

### 6. Verify

```bash
curl -fsS https://app.inflect.bg/api/livez    # 200
curl -fsS https://app.inflect.bg/api/readyz   # 200: the database and Redis answer
```

Then a one-tenant smoke test: sign in, open the dashboard, create a Risk and
read it back, and check that the audit log shows the new entry. Confirm that
`worker` is `healthy` and `watchtower` is running, so scheduled jobs run and the
next merge reaches the VM.

### 7. Bring the host in line with `main`

The snapshot's compose file is whatever the VM ran that day. Once the service
is back, apply the canonical set from the repository, in a service window:

```bash
export VM_NAME=inflect-compliance-restore VM_ZONE="$ZONE"
export HEALTH_ORIGINS="https://app.inflect.bg"
deploy/check-drift.sh        # what differs from the repo
deploy/apply.sh              # preflight only
CONFIRM=1 deploy/apply.sh    # apply
```

`HEALTH_ORIGINS` leaves out the sslip.io origin, which no longer reaches this
VM. `apply.sh` stops in preflight while `REDIS_PASSWORD` is absent from the host
env files (`docs/deployment.md`, "Outstanding operator actions"). That stop
changes nothing, and the stack from step 4 keeps running.

### 8. Make the restored VM the production VM

- **Snapshots.** The new disk has no snapshot schedule, so production has no
  backup until one is attached:

  ```bash
  gcloud compute disks add-resource-policies "$DISK" --zone "$ZONE" \
    --resource-policies inflect-daily-snapshot
  ```

  A snapshot schedule belongs to one region. For a disk in another region,
  create a schedule there with the settings in the table above, and attach
  that.
- **The drill.** `restore-test.yml` in `RodnaPamet/agri-saas` restores
  snapshots of disk `inflect-compliance`. Point it at the new disk, or it keeps
  testing a disk production no longer uses.
- **Names of the old VM.** `deploy/apply.sh` and `deploy/check-drift.sh`
  default to VM `inflect-compliance` in `europe-west1-b`. `HEALTH_ORIGINS` in
  `apply.sh` and the Caddyfile name the old sslip.io address. This doc,
  `docs/deployment.md`, `docs/slos.md`, `docs/sub-processors.md` and
  `CLAUDE.md` name the VM and its zone. Change them in one pull request.
- **The old VM.** If it comes back, its stack starts with it. Stop it at once:
  `gcloud compute instances stop inflect-compliance --zone europe-west1-b`.
  Otherwise two workers each run every scheduled job, each against its own
  database, and both reach tenants' directories, SIEMs and mailboxes. The old
  disk holds the writes made between the snapshot and the outage, and nothing
  merges them into the restored database. Snapshot the old disk and keep it
  until the incident review decides what to do with it.

## Open operational questions

These block raising the customer SLA above "RTO 4h"; decide explicitly:

- **Which region for a region loss?** The snapshots are in the `eu`
  multi-region, and `docs/sub-processors.md` names `europe-west1` as the
  hosting region. A restore outside the EU moves tenant data out of the EU. A
  restore to another EU region changes the declared hosting location. Pick the
  region before it is needed.
- **Who can perform the restore?** The runbook needs a person with Compute
  Engine admin rights on the project and SSH access through IAP. The drill runs
  from another repository and does not exercise a person's access. Name the
  people, and decide how break-glass access is granted and audited.
- **What is the contracted RTO with enterprise customers?** `docs/slos.md`
  SLO 7 states 4 hours, and the full runbook has never been timed. If a
  contract says 1 hour, this posture does not meet it.

## The DR ladder

1. **Daily disk snapshot** *(today)* — RPO 24 hours, RTO 2–4 hours, never
   timed end to end. Cold.
2. **Postgres WAL archiving plus a scheduled dump off the VM** — brings the
   recovery point to minutes (`docs/slos.md`, SLO 6).
   `infra/scripts/pg-dump-to-s3.sh` is in the repo but is not deployed.
3. **A standby database in another zone or region**, fed by continuous WAL
   replication — RPO seconds. It needs a second machine.
4. **Active-active** — not on the roadmap. <!-- docs-accuracy-allow: DR ladder tail listing higher rungs we have deliberately not built -->

Climb a rung only when the RTO/RPO contract demands it; each rung is a
real recurring cost.
