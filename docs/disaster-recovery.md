# Disaster Recovery

This is the **minimum-viable** DR posture: a daily cross-region copy of
the latest automated RDS snapshot, plus a human-driven runbook to
restore from it. It is the bottom rung of the DR ladder — a real
snapshot in a real second region, with an automated restore drill
scheduled monthly, and quarterly for the cross-region copy.

> **⚠ The automated restore drill is failing, and has validated
> nothing.** Every scheduled run of
> `.github/workflows/restore-test.yml` since 2026-05-01 has failed
> within about five seconds, at the "Configure AWS credentials
> (OIDC)" step, with `Input required and not supplied: aws-region`
> — `vars.AWS_REGION` is unset, so the drill has never restored a
> snapshot. Treat the restore half of this posture as untested. A
> second mismatch compounds it: the drill targets AWS RDS, while
> production runs a `postgres:16-alpine` container on a GCP VM.
> Both are tracked in issue #2226.

> **Honest scope.** This is NOT warm-standby, NOT a cross-region
> read-replica, NOT active-active. It buys "if our primary region goes
> dark for a day, we can be back up in another region in 2–4 hours,
> losing at most the last 24h of writes." See
> [What this does NOT protect against](#what-this-does-not-protect-against)
> and [The DR ladder](#the-dr-ladder).

## DR posture: cross-region snapshot copy

| | |
|---|---|
| **RPO (data loss)** | **24h.** We rely on RDS automated snapshots, which run once a day. PITR *within* the source region is ~5 min; PITR is useless once the source region is gone — then the recovery point is the last copied snapshot, i.e. up to 24h old. |
| **RTO (time to restore)** | **~4h.** Cold snapshot → new instance: 30–60 min (size-dependent). App redeploy in DR region: 30–60 min. DNS cutover propagation: ~60 min. Buffer: 30–60 min. Total: **3–4h**. |
| **Cost** | ~**$20/mo** — cross-region snapshot transfer (~$0.02/GB; a daily 100 GB copy ≈ $2/mo, 1 TB ≈ $20/mo) + DR-region storage for the retention window — plus the **multi-region KMS key** (~$1/mo). |
| **Mechanism** | EventBridge fires on each automated-snapshot creation → a Lambda copies it to the DR region (re-encrypted with the DR CMK) → a second daily Lambda prunes copies older than the retention window. All in `infra/terraform/modules/database`, count-gated on `dr_region`. |

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
  *configured* to assume a CI-only OIDC role, but it has never reached
  that step (see the warning at the top of this document), so no
  restore has been performed by CI under any identity. The DR runbook
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
