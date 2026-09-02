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

> **⚠ No SCHEDULED run has ever succeeded.** All three were human-started. The
> 2026-09-01 scheduled attempt died on `ZONE_RESOURCE_POOL_EXHAUSTED`; a zone
> fallback has since been added upstream and its first unattended test is
> 2026-10-01. `.github/workflows/restore-drill-freshness.yml` in this repo now
> watches that drill and fails if no successful run lands within 45 days.

### What was designed and never built

An AWS cross-region snapshot-copy DR posture was designed for this product —
EventBridge on snapshot creation, a Lambda copying to a second region under a
multi-region CMK, a retention Lambda pruning old copies. **It was never
applied.** Every `terraform apply` run failed (13 attempts, 0 successes, no
state file, no configured credentials), and the design was `count`-gated off by
default (`db_dr_region = ""` → zero DR resources) even in intent. There is no
RDS, no S3 and no cross-region copy in the recovery path. Do not plan against
it; see [#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226).

### How it's wired

- `db_dr_region = ""` (default) → **disabled**, zero DR resources, zero cost.
- Set `db_dr_region` + `db_dr_kms_key_arn` (a multi-region CMK replica in
  the DR region) → the copy + retention Lambdas are created.
- Snapshots land in the DR region as **manual** snapshots tagged
  `dr-copy=true`, named `dr-<source-snapshot-id>`. The terraform output
  `dr_snapshot_arn_pattern` is the discovery glob.

### The multi-region KMS prerequisite (path b)

Encrypted cross-region snapshot copy **requires a KMS key in the
destination region**. The current posture is single-region. Two paths:

- **(a)** flip the existing key to `multi_region = true` — a one-time
  migration that **recreates the key** (re-encrypting all existing
  snapshots + secrets). Atomic but disruptive.
- **(b)** create a *second*, multi-region CMK specifically for the
  snapshot copy; snapshots are re-encrypted with it on copy. **We chose
  (b)** — safer for an existing prod environment (no recreation of the
  in-use key). The DR-region replica ARN is passed as
  `db_dr_kms_key_arn`. Land the CMK in a sibling PR first if your team
  prefers atomic applies.

## What this does NOT protect against

- **Sub-24h data loss in a regional outage.** The writes since the last
  snapshot (up to 24h) are gone. If the business cannot tolerate that,
  the next rung is a cross-region read-replica (seconds of RPO).
- **Cache state.** Redis is **not** replicated; sessions + rate-limit
  counters reset on failover. Acceptable — sessions re-auth, rate-limits
  reset harmlessly.
- **In-flight jobs.** BullMQ queue state lives in Redis; jobs enqueued
  since the last snapshot are lost on failover.
- **The evidence object store.** S3 Cross-Region Replication for the
  evidence bucket is a separate, related follow-up (the bucket already
  has versioning + lifecycle).

## Runbook: "primary region is down for >2h"

> Written to be runnable by a stranger on-call at 03:00. Replace
> `<...>` placeholders from the terraform outputs / environment secrets.
> Prereq: the DR-region VPC + SGs are already applied via terraform
> (`terraform apply` with `db_dr_region` set), and you have **break-glass
> IAM** with `rds:RestoreDBInstanceFromDBSnapshot`, `rds:Describe*`,
> Route53, and the Helm/k8s credentials for the DR cluster.

### 0. Decision criteria — cut over or wait?

Cut over only if **all** hold, else wait (cutover is itself disruptive
and failback costs another window):
- The primary region is confirmed down (AWS Health Dashboard / support)
  AND ETA to recovery is **> 2h** or unknown.
- `/api/readyz` on the primary has been failing for **> 15 min** and is
  not a deploy/config issue.
- A responsible owner (on-call lead) has approved cutover in the incident
  channel. Record the decision + timestamp.

### 1. Pre-flight — confirm a restorable DR snapshot exists

```bash
DR_REGION=<db_dr_region>          # e.g. us-west-2
SRC_DB=<SOURCE_DB_INSTANCE_ID>    # e.g. inflect-compliance-production-db

aws rds describe-db-snapshots --region "$DR_REGION" \
  --snapshot-type manual \
  --db-instance-identifier "$SRC_DB" \
  --query 'sort_by(DBSnapshots,&SnapshotCreateTime)[-1].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
  --output text
```
Expected: a snapshot id `dr-...`, a timestamp within the last ~24h, and
status `available`. **If the newest is stale (>36h) or absent, STOP** —
the copy pipeline is broken; escalate, and consider restoring from
whatever copy exists (older RPO) vs. waiting for the primary.

### 2. Restore the snapshot to a new instance (DR region)

```bash
SNAP=<dr-snapshot-id-from-step-1>
NEW_DB="${SRC_DB}-dr-$(date -u +%Y%m%d%H%M)"

aws rds restore-db-instance-from-db-snapshot --region "$DR_REGION" \
  --db-instance-identifier "$NEW_DB" \
  --db-snapshot-identifier "$SNAP" \
  --db-instance-class <db_instance_class> \
  --db-subnet-group-name <DR subnet group> \
  --vpc-security-group-ids <DR db SG> \
  --no-publicly-accessible --multi-az

aws rds wait db-instance-available --region "$DR_REGION" --db-instance-identifier "$NEW_DB"
aws rds describe-db-instances --region "$DR_REGION" \
  --db-instance-identifier "$NEW_DB" --query 'DBInstances[0].Endpoint.Address' --output text
```

### 3. App redeploy in the DR region

```bash
# DR cluster context; the DR VPC/SG come from terraform applied with db_dr_region.
helm upgrade --install inflect infra/helm/inflect \
  -n inflect --create-namespace \
  --values infra/helm/inflect/values-production.yaml \
  --values infra/helm/inflect/values-dr.yaml \
  --set env.DATABASE_URL="postgres://<user>:<pw>@<NEW_DB endpoint>:5432/inflect_compliance?sslmode=require" \
  --set env.OTEL_EXPORTER_OTLP_ENDPOINT=<DR collector endpoint>
```
The DB password is the source instance's master credential (restored
instances inherit it) — read it from Secrets Manager
(`DB_PASSWORD_SECRET_ID`). Create `values-dr.yaml` as a thin overlay on
`values-production.yaml` overriding only the DR-region endpoints.

### 4. DNS cutover (Route53)

Shift the weighted/failover record for the app hostname to the DR
load balancer; drop the primary weight to 0.
```bash
aws route53 change-resource-record-sets --hosted-zone-id <zone> \
  --change-batch file://dr-cutover.json   # DR LB alias, TTL 60
```

### 5. Post-cutover validation

```bash
curl -fsS https://<app-host>/api/livez   # 200
curl -fsS https://<app-host>/api/readyz  # 200 (DB reachable)
```
Then a one-tenant smoke: log in, open the dashboard, create + read one
Risk. Confirm the audit row is hash-chained correctly.

### 6. Failback (when the source region recovers)

1. Bring the source DB current: restore the latest DR snapshot back into
   the source region (or take a fresh snapshot of the DR instance and
   copy it back). Accept the DR-window writes as the new baseline.
2. Redeploy the app in the source region; validate `/api/readyz`.
3. Reverse the Route53 weights (gradually — 10% → 50% → 100%).
4. Decommission the DR instance once traffic is fully back and a clean
   source snapshot exists.

## Open operational questions

These block raising the customer SLA above "RTO 4h"; decide explicitly:

- **Which region is the DR region?** Trade-offs: `us-east-1 ↔ us-west-2`
  (low latency, both US data residency); `ap-east-1` for APAC customer
  coverage; a GDPR-aware EU region for EU tenants (data must not leave
  the EU). This is a data-residency decision, not just a latency one.
- **Who can perform the restore?** The monthly restore-test is
  *configured* to assume a CI-only OIDC role, but it has never
  *completed* that step — every run reaches it and fails inside it, on
  the missing `aws-region` input (see the warning at the top of this
  document) — so no restore has been performed by CI under any
  identity. The DR runbook
  separately needs a **human with break-glass access** (time-boxed,
  audited). Define + provision that role.
- **What is the contracted RTO with enterprise customers?** If the SLA
  is "4h RTO", this PR meets it. If it's "1h RTO", this is not
  sufficient — the next rung (cross-region read-replica) must land.

## The DR ladder

1. **Cross-region snapshot copy** *(this)* — RPO 24h, RTO 4h, ~$20/mo. Cold.
2. **Cross-region read-replica** — RPO seconds, RTO ~1h, ~3× cost. Hot (continuous WAL replication).
3. **Warm-standby** (Aurora Global + Redis Global Datastore + traffic routing) — RPO seconds, RTO minutes. See `docs/multi-region.md`.
4. **Active-active** — not on the roadmap. <!-- docs-accuracy-allow: DR ladder tail listing higher rungs we have deliberately not built -->

Climb a rung only when the RTO/RPO contract demands it; each rung is a
real recurring cost.
