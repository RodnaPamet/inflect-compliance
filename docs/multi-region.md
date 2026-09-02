# Cross-Region Warm-Standby — Design

> **Status: living design** — describes a direction that is partially shipped. See the "Current state" and "Roadmap" sections for what is and isn't true today.

**Status:** design for engineering + customer-security review. **No
infrastructure code ships with this doc** — the Terraform/Helm follow up
after this design is approved. This is the artefact the decision lands on.

The platform is **single-region today** (`var.aws_region = us-east-1`
for both staging and production). There is no cross-region replica, no
failover runbook beyond in-region restore, and the committed recovery
objectives (`docs/slos.md` SLO 6/7: **RPO ≤ 1h, RTO ≤ 4h**) already note
that "cross-region read replica deployment is the mitigation; not in
scope for OI-3." This doc specifies that mitigation.

## Current state (true today)

### Today's posture (the baseline we're moving from)

| Layer | Today (from `infra/terraform/`) |
|-------|----------------------------------|
| **Region** | Single — `var.aws_region` = `us-east-1` (prod + staging tfvars) |
| **DB** | RDS Postgres 16, `storage_encrypted = true` (hardcoded) under the per-env KMS CMK (`var.kms_key_arn`); `multi_az` = **true (prod)** / **false (staging)**; `backup_retention_period` 1–35 days with implicit PITR (0 disallowed). |
| **Cache** | ElastiCache Redis 7, `aws_elasticache_replication_group`, **cluster-mode-disabled** (1 node group); `multi_az_enabled` with ≥1 replica per node group on prod. |
| **Storage** | S3 per env — **versioning enabled**, **SSE-S3 (AES256)** (AWS-managed key, *not* a per-bucket KMS CMK), lifecycle → STANDARD_IA at 90d + capped noncurrent retention. |
| **KMS / secrets** | Per-env KMS CMK (`var.kms_key_arn`) encrypts RDS storage + the Secrets Manager / SSM entries (`modules/secrets`). **Single-region key.** |
| **App-layer encryption (Epic B)** | Separate from AWS KMS: a master KEK (`DATA_ENCRYPTION_KEY`, a secret) wraps a per-tenant DEK on `Tenant.encryptedDek`; per-row business fields are encrypted via the Epic B manifest. See `docs/epic-b-encryption.md`. |
| **Backups** | RDS automated backup + snapshot retention; **monthly** restore-test (`.github/workflows/restore-test.yml`, `cron: 0 4 1 * *`) on a **self-hosted in-VPC runner**, **same region**. |

**Stateful vs stateless inventory** (what has to cross the wire vs what
just redeploys):

- **Stateful** (needs replication): Postgres (incl. `Tenant.encryptedDek`
  + Epic B encrypted columns — they replicate *as ciphertext* with the
  DB row), Redis (rate-limit counters + Epic E.2 audit-stream buffers +
  BullMQ), S3 evidence files, the KMS CMK + the app-layer master KEK.
- **Stateless** (redeploy from the Helm chart): app, worker, PgBouncer.

### RPO / RTO targets

These extend `docs/slos.md` SLO 6/7. The committed platform SLO is
**RPO ≤24h / RTO ≤4h** — the full-recovery objective, met today by a
daily crash-consistent disk snapshot of the single production VM. (An
earlier revision stated RPO ≤1h on the strength of RDS PITR; there is no
RDS and no PITR — see #2226.) The tiers below are **design targets for a
multi-region architecture that does not exist yet**, not commitments:

| Tier | RPO | RTO | Applies to | Mechanism |
|------|-----|-----|------------|-----------|
| **same-region HA** | ≤60s | ≤5min | all tenants **today** | RDS Multi-AZ automatic failover (AZ-level only — *not* a regional outage; the regional-outage path is still the SLO-6/7 1h/4h restore) |
| **cross-region warm-standby** | ≤5min | ≤30min | **Enterprise tier only** (gated by `billing.plan`) | Aurora Global + Redis Global Datastore + S3 CRR + KMS replica; manual promotion |
| **cross-region active-active** | ≤0 (sync) | ≤2min | **not on the roadmap — design only** | bidirectional sync + write-conflict resolution |

**Cost vs benefit.** *same-region HA* is free of additional design — it's
the Multi-AZ we already pay for; it does nothing for a regional outage.
*Warm-standby* roughly **doubles infra cost** (a second region's DB
replica, cache, replicated storage, idle/low app capacity) to buy
regional-outage survival at ≤5min RPO / ≤30min RTO. *Active-active*
roughly **triples cost** AND adds a write-conflict-resolution surface
(CRDTs / last-writer-wins / app-level merge) that is an 18-month
engineering effort — the benefit (≤2min RTO, zero RPO) does not justify
the cost or risk for any committed customer requirement today.

## Roadmap (future direction)

### Target architecture: cross-region warm-standby

The recommended posture for the next 12 months.

### DB — Aurora Postgres Global Database
Migrate RDS Postgres → **Aurora Postgres Global Database**. Aurora Global
replicates at the storage layer with typical cross-region lag <1s and a
managed promotion API. **Argue Aurora over cross-region RDS read-replica:**
an RDS read-replica needs *manual* promotion + DNS surgery + can lag
under load — the realistic RTO is well over 30min, missing the tier
target. Aurora Global's managed failover meets ≤30min comfortably.
**Promotion sequence:** detect regional failure → **promote the standby
Aurora replica to primary** (managed failover) → **cut over Route53** to
the standby region's ALB → **drain/fence the old primary** (prevent
split-brain writes) → resume.

### Cache — ElastiCache Redis Global Datastore
**Redis Global Datastore** (active-passive cross-region replication) for
the existing cluster-mode-disabled replication group. Carries the
per-tenant rate-limit counters + the Epic E.2 audit-stream buffers.
**Eventual-consistency window:** typically <1s healthy, can spike to ~10s
under cross-region network impairment. Implication: post-failover, a few
seconds of rate-limit state and unflushed audit-stream buffer may be
stale/lost — acceptable because audit rows are already DB-committed
(Epic C.4/E.2 are fail-safe) and rate-limit counters are advisory.

### Storage — S3 Cross-Region Replication
**S3 CRR** for the evidence-file bucket → a standby-region bucket
(replication is **asynchronous** — a fresh upload is **not** immediately
readable in the standby; replication latency is typically seconds-to-minutes
and is *not* bounded by an SLA). Keep same-region versioning for the
audit-log bucket (it's the tamper-evident record; CRR is additive). The
RPO for evidence files is therefore the CRR lag, not the DB RPO — call
this out to enterprise customers.

### KMS + app-layer KEK — both must exist in both regions
Two distinct key stories, both of which must be region-redundant or
**decrypt-after-failover silently fails**:
1. **AWS KMS CMK** (RDS storage, Secrets Manager): use a **KMS
   Multi-Region Key** (primary + replica key) so the standby-region DB
   can decrypt its storage. (S3 is SSE-S3/AES256 — AWS-managed, already
   region-local, no action.)
2. **App-layer master KEK** (`DATA_ENCRYPTION_KEY`, Epic B): the
   per-tenant DEK on `Tenant.encryptedDek` replicates *as ciphertext*
   with the Aurora row, but it's wrapped under the master KEK — so the
   **same master KEK value must be present in the standby region's
   secret store**, or every per-tenant decrypt fails after cutover. The
   `DATA_ENCRYPTION_KEY_PREVIOUS` rotation contract (Epic B) must be
   honoured in **both** regions in lockstep: rotate the new primary into
   both regions' secret stores *before* removing the previous, so a
   mid-rotation failover can still `decryptWithKeyOrPrevious`.

### App / worker — both regions, same chart
Stateless: deploy the same Helm chart in the standby region with
region-scoped values overrides (warm = low/zero replicas until cutover —
see [migration Phase 1](#migration-path-12-month-roadmap)). **Traffic
routing: Route53 weighted (active-passive).** Argue weighted DNS over AWS
Global Accelerator: GA's value is *latency* steering, not DR; for an
active-passive failover, weighted DNS (100/0 → 0/100 on promotion) is
simpler, cheaper, and the cutover is a record change. (TTL must be low —
e.g. 60s — so the cutover propagates within the RTO.)

### Auth tokens — already region-portable
NextAuth JWT session cookies are **domain-scoped, not region-scoped**: a
session minted in us-east-1 verifies against the same `AUTH_SECRET` in
the standby region, so it stays valid through a cutover (no re-login).
The Epic C.3 `UserSession` row replicates with the Aurora DB; the
standby-region session-touch (`verifyAndTouchSession`) is eventual until
DNS cuts over (until then writes still land on the primary region). No
design change needed beyond ensuring `AUTH_SECRET` is identical in both
regions' secret stores (same constraint as the master KEK).

### Migration path (12-month roadmap)

**Phase 1 (Q3) — plumbing.** Provision the standby region in Terraform;
deploy the Helm chart in DR mode (0 replicas — namespace + config only).
Verify connectivity to the (not-yet-replicated) DB/cache/storage.
**RPO/RTO targets NOT met yet** — this is wiring.

**Phase 2 (Q4) — replication.** Enable replication on the stateful tiers:
Aurora Global, Redis Global Datastore, S3 CRR, KMS Multi-Region Key.
Smoke the **read path** in the standby (read-only DR traffic served
cleanly). Extend the restore-test to include **cross-region** restore
validation.

**Phase 3 (Q1 next) — runbook + drills.** Write the failover runbook
under `docs/incident-response.md`'s playbook tree. Practice it
**quarterly**; do a **1-hour controlled cutover once per quarter** to
keep the runbook honest (a runbook never rehearsed is fiction).

**Phase 4 (Q2 next) — productise.** Gate the cross-region tier behind the
**Enterprise** billing plan (`src/lib/billing/entitlements.ts` already
has FREE/TRIAL/PRO/ENTERPRISE gates). Smaller tenants stay single-region;
their commitment remains *same-region HA* (already met by Multi-AZ +
SLO 6/7).

### What this doc is NOT

- **Active-active design.** The CRDT / write-conflict surface is an
  ~18-month effort nobody has asked for. Mentioned above; not specified.
- **A vendor lock-in argument.** Today's Terraform is AWS-shaped, so the
  recommendation is Aurora Global (where the primary lives). A GCP/Azure
  parallel is a separate follow-up.
- **A SOC2 / FedRAMP / ISO 27001 compliance spec.** This informs those
  commitments; it does not replace the auditor conversation.

### Open questions (engineering-review decision gates)

These must be answered **before Phase 1**. My recommendation is given for
each (the PR review is where they're decided):

1. **Which standby region?** — *Recommend `us-west-2`*: a different AWS
   geography from `us-east-1` (real blast-radius separation), full
   service availability (Aurora Global / Redis Global Datastore / KMS
   MRK all supported), and the canonical us-east-1↔us-west-2 DR pair.
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
5. **How does the monthly restore-test evolve?** — *Recommend a parallel
   cross-region restore-test* on a standby-region self-hosted runner with
   cross-account/cross-region IAM trust; the existing in-region monthly
   test stays. They validate different things (in-region PITR vs
   cross-region replica integrity).
