# Cross-Region Warm-Standby — Design

> **Status: living design** — a design for regional failover. None of it is built. "Current state" says what production has today; "Roadmap" is the design.

Production is one GCP VM in one zone, running the Compose stack in
`deploy/docker-compose.prod.yml` ([`docs/deployment.md`](deployment.md)).
Nothing is replicated to another zone or region. If the VM, its disk, its zone
or its region is lost, recovery is a manual restore of the newest daily disk
snapshot, described in [`docs/disaster-recovery.md`](disaster-recovery.md).

## Current state (true today)

### Today's posture

| Layer | Today |
|-------|-------|
| **Region** | One VM in one zone of one EU region (`docs/sub-processors.md` names it). There is no standby in another zone or region. |
| **Database** | The `postgres` service (`postgres:16-alpine`) on the VM, behind PgBouncer. Its data is a Docker volume on the VM's one disk. No replica, no WAL archive (`archive_mode=off`), no point-in-time recovery. |
| **Cache and queue** | The `redis` service (`redis:7-alpine`): BullMQ jobs, rate-limit counters and the cache. AOF persistence, on a Docker volume on the same disk. |
| **Evidence files** | `STORAGE_PROVIDER=local`: a Docker volume on the same disk. There is no object store. |
| **Secrets and keys** | Host env files on the same disk, including the master KEK (`DATA_ENCRYPTION_KEY`). There is no managed secret store and no cloud KMS key. |
| **App-layer encryption (Epic B)** | The master KEK wraps a per-tenant DEK on `Tenant.encryptedDek`, and the manifest's fields are encrypted per row. See `docs/epic-b-encryption.md`. The ciphertext lives in the database, so every snapshot carries it. |
| **Backups** | One crash-consistent snapshot of the disk a day, kept 14 days, stored in the `eu` multi-region. A drill in another repository restores a snapshot and checks the database. On 2026-10-19 no scheduled run of that drill had succeeded yet (`docs/disaster-recovery.md`). |

**Stateful and stateless.** Everything stateful is on the VM's one disk: the
Postgres volume (with `Tenant.encryptedDek` and the Epic B ciphertext), the
Redis volume, the evidence volume, Caddy's certificate volume and the host env
files holding the master KEK. One snapshot captures all of it at one moment,
and loses all of it together. The stateless services start again from their
images: `app` and `worker` (from GHCR), `pgbouncer`, `clamav` (it downloads its
signatures again) and `watchtower`.

### RPO / RTO today

`docs/slos.md` commits to an RPO of 24 hours (SLO 6) and an RTO of 4 hours
(SLO 7). These hold for every tenant, and there is no other tier.

- **RPO 24 hours.** The recovery point is the newest snapshot, so a restore
  loses up to a day of writes.
- **RTO 2–4 hours, estimated.** The restore in `docs/disaster-recovery.md`
  creates a disk from the snapshot in another zone, boots a VM on it and moves
  DNS. It has never been run end to end or timed.

A zone loss and a region loss take the same path. The only difference is where
the new disk and VM go.

## Roadmap (future direction)

This design was written for an AWS estate (`infra/terraform/`: RDS,
ElastiCache, S3, KMS, Route53) that was never provisioned and was removed on
2026-09-02 ([#2226](https://github.com/RodnaPamet/inflect-compliance/issues/2226)).
The mechanisms it names are AWS services. Production runs on GCP, so following
it means either moving production to AWS first or working out each mechanism
again for GCP. Neither has been decided. The parts that do not depend on the
cloud carry over either way: the tiers, the two key stories, region-portable
sessions, manual failover, per-tenant opt-in and the open questions.

The tiers below are the third and fourth rungs of the DR ladder in
`docs/disaster-recovery.md`. Its second rung, WAL archiving plus a dump off
the VM, brings the RPO to minutes without a second region, and comes first.

### Target tiers

Design targets, not commitments. None is built.

| Tier | RPO | RTO | Applies to | Mechanism |
|------|-----|-----|------------|-----------|
| **same-region HA** | ≤60s | ≤5min | all tenants | A standby database in a second zone of the same region, fed by streaming replication, with automatic failover. Survives a zone loss, not a region loss. |
| **cross-region warm-standby** | ≤5min | ≤30min | **Enterprise tier only** (gated by `billing.plan`) | Aurora Global + Redis Global Datastore + S3 CRR + KMS replica; manual promotion |
| **cross-region active-active** | ≤0 (sync) | ≤2min | **design only, not planned** | bidirectional sync + write-conflict resolution |

**Cost vs benefit.** *Same-region HA* needs a second machine and replication,
and does nothing for a regional outage. *Warm-standby* roughly **doubles infra
cost** (a second region's database replica, cache, replicated storage and
idle or low app capacity) to buy regional-outage survival at ≤5min RPO /
≤30min RTO. *Active-active* roughly **triples cost** AND adds a
write-conflict-resolution surface (CRDTs / last-writer-wins / app-level merge)
that is an 18-month engineering effort. Its benefit (≤2min RTO, zero RPO) does
not justify the cost or risk for any committed customer requirement.

### Target architecture: cross-region warm-standby

The recommended posture once a customer requirement calls for one.

### DB — Aurora Postgres Global Database
Move the database to **Aurora Postgres Global Database**. Aurora Global
replicates at the storage layer with typical cross-region lag <1s and a
managed promotion API. **Argue Aurora over a cross-region RDS read-replica:**
an RDS read-replica needs *manual* promotion + DNS surgery + can lag
under load — the realistic RTO is well over 30min, missing the tier
target. Aurora Global's managed failover meets ≤30min comfortably.
**Promotion sequence:** detect regional failure → **promote the standby
Aurora replica to primary** (managed failover) → **cut over Route53** to
the standby region's load balancer → **drain/fence the old primary** (prevent
split-brain writes) → resume.

### Cache — ElastiCache Redis Global Datastore
**Redis Global Datastore** (active-passive cross-region replication) for a
cluster-mode-disabled replication group. It carries the per-tenant rate-limit
counters, the BullMQ queue and the Epic E.2 audit-stream buffers.
**Eventual-consistency window:** typically <1s healthy, can spike to ~10s
under cross-region network impairment. Implication: post-failover, a few
seconds of rate-limit state and unflushed audit-stream buffer may be
stale/lost — acceptable because audit rows are already DB-committed
(Epic C.4/E.2 are fail-safe) and rate-limit counters are advisory.

### Storage — S3 Cross-Region Replication
Move evidence files to an S3 bucket with **S3 CRR** to a standby-region
bucket. Replication is **asynchronous**: a fresh upload is **not** immediately
readable in the standby, and replication latency is typically
seconds-to-minutes with no SLA. The RPO for evidence files is therefore the
CRR lag, not the DB RPO — call this out to enterprise customers.

### KMS + app-layer KEK — both must exist in both regions
Two distinct key stories, both of which must be region-redundant or
**decrypt-after-failover silently fails**:
1. **AWS KMS CMK** (database storage, Secrets Manager): use a **KMS
   Multi-Region Key** (primary + replica key) so the standby-region database
   can decrypt its storage. A bucket under SSE-S3 needs no key of ours.
2. **App-layer master KEK** (`DATA_ENCRYPTION_KEY`, Epic B): the
   per-tenant DEK on `Tenant.encryptedDek` replicates *as ciphertext*
   with the database row, but it's wrapped under the master KEK — so the
   **same master KEK value must be present in the standby region's
   secret store**, or every per-tenant decrypt fails after cutover. The
   `DATA_ENCRYPTION_KEY_PREVIOUS` rotation contract (Epic B) must be
   honoured in **both** regions in lockstep: rotate the new primary into
   both regions' secret stores *before* removing the previous, so a
   mid-rotation failover can still `decryptWithKeyOrPrevious`.

### App / worker — both regions, same image
Stateless: run the same image in the standby region with region-scoped
configuration (warm = low or no capacity until cutover — see
[migration Phase 1](#migration-path)). **Traffic
routing: Route53 weighted (active-passive).** Argue weighted DNS over AWS
Global Accelerator: GA's value is *latency* steering, not DR; for an
active-passive failover, weighted DNS (100/0 → 0/100 on promotion) is
simpler, cheaper, and the cutover is a record change. (TTL must be low —
e.g. 60s — so the cutover propagates within the RTO.)

### Auth tokens — region-portable
NextAuth JWT session cookies are **domain-scoped, not region-scoped**: a
session minted in the primary region verifies against the same `AUTH_SECRET`
in the standby region, so it stays valid through a cutover (no re-login).
The Epic C.3 `UserSession` row replicates with the database; the
standby-region session-touch (`verifyAndTouchSession`) is eventual until
DNS cuts over (until then writes still land on the primary region). No
design change needed beyond ensuring `AUTH_SECRET` is identical in both
regions' secret stores (same constraint as the master KEK).

### Migration path

**Phase 1 — plumbing.** Provision the standby region and deploy the app there
in DR mode (configuration only, nothing serving). Verify connectivity to the
(not-yet-replicated) database, cache and storage.
**RPO/RTO targets NOT met yet** — this is wiring.

**Phase 2 — replication.** Enable replication on the stateful tiers:
Aurora Global, Redis Global Datastore, S3 CRR, KMS Multi-Region Key.
Smoke the **read path** in the standby (read-only DR traffic served
cleanly). Extend the restore drill to include **cross-region** restore
validation.

**Phase 3 — runbook + drills.** Write the failover runbook
under `docs/incident-response.md`'s playbook tree. Practice it
**quarterly**; do a **1-hour controlled cutover once per quarter** to
keep the runbook honest (a runbook never rehearsed is fiction).

**Phase 4 — productise.** Gate the cross-region tier behind the
**Enterprise** billing plan (`src/lib/billing/entitlements.ts` already
has FREE/TRIAL/PRO/ENTERPRISE gates). Smaller tenants stay single-region,
and their commitment stays SLO 6/7.

### What this doc is NOT

- **Active-active design.** The CRDT / write-conflict surface is an
  ~18-month effort nobody has asked for. Mentioned above; not specified.
- **A GCP design.** It is AWS-shaped because it was written for the AWS
  estate. A GCP version of it has not been written.
- **A SOC2 / FedRAMP / ISO 27001 compliance spec.** This informs those
  commitments; it does not replace the auditor conversation.

### Open questions (engineering-review decision gates)

These must be answered **before Phase 1**. A recommendation is given for each:

1. **Which standby region?** — The design first recommended `us-west-2`,
   paired with a `us-east-1` primary that never existed. Production is in the
   EU (`docs/sub-processors.md`), and a standby outside the EU moves tenant
   data out of it. *Recommend another EU region.* `docs/disaster-recovery.md`
   asks the same question for a restore after a region loss.
2. **Which billing tier gates warm-standby?** — *Recommend ENTERPRISE
   only* (matches the cost; the entitlement gate already exists).
3. **Failover policy: manual or automatic?** — *Recommend manual for
   year one.* Automatic-failover decision logic (distinguishing a true
   regional outage from a transient blip without flapping) is a
   non-trivial engineering surface; a human promote-decision with a
   rehearsed runbook is safer initially.
4. **Cross-region data-residency story?** — *Recommend opt-in per-tenant,
   not platform-wide enforced.* Some enterprise customers **require**
   in-region-only — warm-standby that replicates their data to a second
   region would violate that, so it must be a per-tenant opt-in, not a
   blanket default.
5. **How does the restore drill evolve?** — *Recommend a separate
   cross-region drill beside the existing one.* The existing drill restores a
   disk snapshot and checks the database. A standby needs its own check of
   replica integrity and of promotion.
