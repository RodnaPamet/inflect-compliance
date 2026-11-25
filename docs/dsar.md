# Data Subject Access Requests (DSAR)

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md). DSAR is
> the compliance-driven flip side of [`docs/data-retention.md`](data-retention.md)
> (what we keep) — it is how a data subject exercises GDPR Art. 15 (access/export)
> and Art. 17 (erasure).

## Scope of this document — what is built, and what can run

DSAR is a multi-PR sequence (each PR carries the `dsar` prefix). Read the
right-hand column as two separate questions: does the code exist, and can
anything reach it.

| Stage | Scope | Status |
|-------|-------|--------|
| **1 — Foundation** | `DataSubjectRequest` model + migration, the workflow state machine, rejection criteria, cooling-off + verification constants, the export/erasure job skeletons, this doc, the ratchet. | shipped |
| 2 — Export pipeline | Produce the bundle (decrypt authored content, write to S3, 7-day signed URL, email). Reversible → sequenced first. | open |
| 3 — Erasure pipeline | The irreversible cascade, plus the `IMMUTABLE_AUDIT_LOG` trigger narrowing that permits pseudonymization. | **cascade + trigger shipped; reachable only through an operator command** |
| 4 — Admin UI + rollout | `/admin/dsar-requests` (`admin.compliance_dsar`), monitoring, production rollout. | open |

**Stage 3's `eraseUser` EXECUTES — and only an operator reaches it.** The
function in `src/app-layer/jobs/dsar-erasure.ts` performs the real cascade
against the client it is given: it is no longer a stub that throws. It is
absent from `register-schedules` and `executor-registry`, and no route, usecase
or job in `src/` calls it — so no scheduler fires it and no request reaches it.
Its one entry point is the operator command `scripts/dsar-erase.ts`
(`npm run dsar:erase`, #5802 and #5940, owner decisions 2026-11-25), which has
no HTTP route. In production it runs through the `VM apply` actions
`dsar-erase-preflight` and `dsar-erase` (`node dist/dsar-erase.mjs --due` in the
app container). The operator procedure is `docs/runbooks/dsar-erasure.md`.

The command takes a **register request**, never a person: `--request <id>`, or
`--due` for the one ERASURE request that is due (verified, past its cooling-off,
not completed, rejected or cancelled; refused unless exactly one is). It reads
the subject from the request and refuses, each by a named reason, a request that
is not an erasure (`NOT_AN_ERASURE`), already completed (`ALREADY_COMPLETED`),
rejected (`REQUEST_REJECTED`), cancelled (`REQUEST_CANCELED`), not verified
(`NOT_VERIFIED`), still cooling off (`COOLING_OFF`), not started
(`NOT_IN_PROGRESS`), whose subject is already erased (`SUBJECT_ALREADY_ERASED`),
or that `evaluateDsarRejection` refuses (`REJECTION_CRITERION`, see below). It
refuses a tenant's system user (`sys_` id), and refuses whatever `planErasure`
says would refuse the delete — a membership in any status among it. A plan that
`--confirm` would refuse exits 1, so a passing preflight means the write may run.

**The erase is bound to the preflight that showed it** (owner decision
2026-11-25, third round). Without `--confirm` or `--check`, the command is the
PREFLIGHT: it prints the plan and, only when the plan would be admitted, stamps
the request it showed (`DataSubjectRequest.erasurePreflightAt`, written only by
`stampErasurePreflight`). That stamp is the only write a preflight makes.
`--confirm` refuses a request no preflight stamped (`NOT_PREFLIGHTED`) or one
stamped more than `ERASURE_PREFLIGHT_VALID_HOURS` (24) ago
(`PREFLIGHT_EXPIRED`), and `eraseUser` asks the same again inside its
transaction. `--check` decides as `--confirm` does and writes nothing; it is the
`dsar-erase` action's same-run preflight, because a check that stamped would let
the write vouch for whatever request had become due. So if the request the owner
read is cancelled and another becomes due between the two actions, the approved
erase refuses the other one. The stamp is kept with the surviving row, as
evidence of which preview the erasure was approved on. It prints ids,
statuses, timestamps and counts only; it never reads the person's e-mail or
name. Its audit record is `eraseUser`'s own: no tenant `DSAR_COMPLETED` row is
written for the request it completes.

`--user <id>` was retired with #5940: every erasure has a register row as its
record. A person who asks outside the product is recorded on the register first
(`/admin/dsar-requests`), which also gives the erasure its accountable handler.

### The register row survives, unlinked

`DataSubjectRequest.userId` is nullable and `ON DELETE SET NULL ("userId")`
(migration `20261125140000_dsar_request_user_set_null`, owner decision
2026-11-25), so the register is no longer a blocker. Inside the erasure's
transaction, before the hard delete, `fulfilErasureRequestWithin`
(`src/app-layer/jobs/dsar-erasure-request.ts`):

- moves the request being fulfilled from `IN_PROGRESS` to `COMPLETED` and sets
  `completedAt`, by a conditional claim on that exact state; `handledById` stays
  the admin who started it;
- nulls `fulfilmentNotes` (free text staff wrote, which can name the person) and
  `exportUrl` on **every** request of the subject.

The hard delete then nulls `userId` on all of them. What remains is the type,
status, dates, rejection reason and handler: evidence that the request was
handled, pointing at nobody. **It is evidence in the database only.** The
register lists a request through its subject's ACTIVE membership
(`scopedToTenantMembers`, and the same predicate in the RLS policy), so no
tenant's register shows an erased request; reading one takes a role that is not
`app_user`.

The register therefore has two writers of requests — `dsar-register.ts` (an
admin, in a tenant) and `fulfilErasureRequestWithin` (the erasure, as the
system) — plus the container-start format repair `dsr-legacy-decrypt.ts`.
`tests/guards/dsar-register-writers.test.ts` holds that set.

### Which workspaces an erasure covers

After the erasure commits, every KEPT Managed Agents session in every workspace
where the person held a membership is deleted (Step 5c). Those workspaces are
read from the audit trail by `readErasureWorkspaces`
(`src/app-layer/jobs/dsar-erasure-workspaces.ts`), inside the erasure's own
transaction and before the pseudonymization, because by then no membership row
is left to read: a workspace counts when the person's own row is there, when a
membership writer's row names them as its entity (SCIM's lifecycle rows, the
org-admin fan-out, the platform-admin tenant creation), when a REMOVAL names
them as `detailsJson.targetUserId` (#5940: `MEMBER_REMOVED`,
`MEMBER_DEACTIVATED`, `SCIM_USER_DEACTIVATED`, `ORG_ADMIN_DEPROVISIONED`,
`ACCESS_REVIEW_DECISION_EXECUTED`), or when the org trail's fan-out row lists
it. The same function prints the command's plan.

Some membership writers record no row naming the person at the JOIN —
credentials signup, SSO just-in-time provisioning, an org admin creating a
tenant, the org-admin fan-out into a new org tenant, the staging seed. Since
#5940 their workspaces are found from the removal instead: `planErasure`
refuses while any membership is left, so every erasure is preceded by one, and
every removal and deactivation names the person. Two gaps remain, and the plan
lists them every time rather than claiming completeness: a removal written
before #5940, which carries no `targetUserId` (the trail is immutable, so they
were not backfilled), and the tenant purge, which deletes a purged tenant's
memberships without naming anybody and runs its own Managed Agents clean-up
first. A membership row naming the person under an action the module does not
list is reported as undecided, and the command refuses `--confirm` until it is
classified. A `targetUserId` under an action it does not list is ignored: the
key is the actor convention on many rows that say nothing about a membership.

The user id in a removal row's `detailsJson` is streamed to the tenant's SIEM
with the rest of `detailsJson` (Epic C.4), as `targetUserId` already was on the
DSAR, access-review and org fan-out rows: an opaque id, never an e-mail. After
the erasure the id resolves to nobody — the `User` row is gone — but the audit
trigger permits only `userId` → NULL, so the id stays in those rows.

`dsar-export.ts` is unchanged: it still throws if called and is still
unregistered.

Its sibling `planErasure`, in the same module, is the **dry run** — it reports
which references would refuse the Stage 2 hard delete for a given subject, and
writes nothing (`writes: 0`, asserted by capturing every statement it issues).
The operator command prints it before anything is written.

**Erasure refuses up front when anything blocks it** (#5595, owner decision
2026-11-14). `eraseUser` runs `planErasure` inside its own transaction before
its first write and throws `ErasureBlockedError` (a 409 `ConflictError`
carrying the blockers) when the plan lists any. Each blocker names a `reason`:

| `reason` | Meaning |
|----------|---------|
| `IMMUTABLE_AUDIT_TRAIL` | `OrgAuditLog.actorUserId` / `targetUserId` names the subject. The table is append-only and hash-chained, so the reference stays. |
| `STAMPED_DECISION_ACTOR` | A recorded decision names the subject as its actor: `AccessReviewDecision.decidedByUserId` / `executedByUserId`, `AccessReviewConnectedDecision.decidedByUserId`, `ControlException.approvedByUserId` / `rejectedByUserId`, `RiskTreatmentPlan.completedByUserId`, `TreatmentMilestone.completedByUserId`. A pair CHECK or a one-way trigger keeps that actor set. |
| `RESTRICT_REFERENCE` | Any other `ON DELETE RESTRICT` / `NO ACTION` reference (a membership, a notification, …), which can be resolved and the erasure re-run. |

The first two sets are `ON DELETE RESTRICT` in the database (migration
`20261114140000_dsar_erasure_audit_references_restrict`), and `planErasure`
treats them as blockers whatever action the catalog reports, because a SET NULL
on any of them fails part-way on the trigger or the CHECK. `AuditLog.userId` is
not among them: erasure pseudonymizes it, as described below. Erasing a person
whom the org audit trail or a stamped decision names is not possible today; it
would need a pseudonymisation of those records, which was considered and not
chosen.

Two deviations from the original brief, both flagged: (a) `DataSubjectRequest`
carries **no `tenantId`** — a DSAR is user-scoped/cross-tenant, and a `tenantId`
column would (correctly) pull the table into the RLS-coverage requirement; the
relevant tenants are derived from the user's memberships at execution time.
(b) The interactive intake (HTTP route + verification email) sequences with the
export pipeline (Stage 2) rather than landing as a non-executing stub here.

## Workflow

1. The user submits a DSAR (`EXPORT` or `ERASURE`).
2. A verification email goes to the user's verified address; status is `RECEIVED`.
3. The user clicks the link → status `VERIFIED` (`verifiedAt` set).
4. **ERASURE only — 24h cooling-off.** The erasure job does not fire until
   `DSAR_COOLING_OFF_HOURS` (24) after `VERIFIED`, giving the user time to cancel
   an irreversible deletion (`coolingOffElapsed()` in `dsar-erasure.ts`).
   Cancellation (`DELETE /api/me/dsar/<id>`) is allowed during this window only.
5. A background job runs the `VERIFIED` request → status `IN_PROGRESS`.
6. `EXPORT` produces a signed bundle (7-day TTL) and emails the link; `ERASURE`
   runs the cascade. Status → `COMPLETED`; a confirmation email is sent.

Erasure additionally requires step-up verification: email click-through **plus**
password re-entry (credentials auth) **plus** an MFA challenge (if enabled).

Every transition emits an audit entry (category `access`): `DSAR_REQUESTED`,
`DSAR_VERIFIED`, `DSAR_CANCELED`, `DSAR_COMPLETED`, `DSAR_REJECTED`. These are
retained indefinitely — they document the platform's compliance with the request.

## Rejection criteria

Not every DSAR can be honored as submitted (ERASURE only — EXPORT is always
safe). Reasons are the `DSAR_REJECTION_REASONS` constants in `src/lib/dsar.ts`,
evaluated by the pure `evaluateDsarRejection()`:

| Reason | Why | How the user resolves it |
|--------|-----|--------------------------|
| `LAST_OWNER` | Erasing the sole ACTIVE OWNER of a tenant orphans it. | Transfer ownership, or delete the tenant, then re-request. |
| `OUTSTANDING_BALANCE` | Unpaid billing. | Finance resolves the balance first. |
| `LEGAL_HOLD` | An active legal hold (the hold feature is a future addition; reserved). | The hold must be lifted by legal. |

`LAST_OWNER` is checked first — it is the most common and the only one the user
can resolve themselves.

The erasure command applies it (#5940, owner decision 2026-11-25):
`LAST_OWNER` is computed from the subject's live memberships (by the time an
erasure may run it is 0, because `planErasure` refuses while any membership is
left, but it is asked rather than assumed). The product holds no balance and no
legal hold for a person, so those two are passed as absent, and every plan
prints that they remain the operator's check.

## Audit-log pseudonymization (not deletion)

Erasure **pseudonymizes** the audit trail — it sets `AuditLog.userId = NULL` for
the user's rows — rather than deleting them. Rationale:

- Deleting audit rows breaks the hash chain and is **refused by the
  `IMMUTABLE_AUDIT_LOG` trigger** by design.
- GDPR **Art. 17(3)(b)** exempts processing necessary for compliance with a legal
  obligation — the audit trail *is* that obligation. The lawful basis to retain
  the *record of the action* survives the erasure of the *actor's identity*.

So the action is retained; the identifying `userId` is removed.

**Two gates, one of them narrowed.** Migration
`20260917130000_audit_log_immutable_permit_pseudonymization` narrowed
`audit_log_immutable_guard()` to permit exactly one UPDATE shape —
`OLD."userId" IS NOT NULL`, `NEW."userId" IS NULL`, and
`to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'`, which covers every other
column including `entryHash` / `previousHash`. DELETE stays unconditionally
refused. The PRIVILEGE gate was deliberately left alone: `app_user` still has
UPDATE and DELETE on `AuditLog` revoked outright, so tenant-path code cannot
attempt the write at all, permitted shape or not. Erasure therefore runs via
`runInGlobalContext`, which never drops to `app_user` — granting UPDATE back to
`app_user` would widen this to every tenant request in the product and is not
how erasure is to be made to work.

The trigger grades ONE ROW at a time against a SHAPE. It cannot know whose
erasure is running, so a statement that nulled `userId` on every row in the
table would satisfy it row by row. Not over-anonymizing is an APPLICATION
obligation — it lives in the `where` clause of the single `updateMany` inside
`eraseUser`.

### The erasure is recorded IN the chain, and the verifier consults it

"Hash chain intact" names two properties, and pseudonymization splits them.
The STORED chain survives byte-for-byte — that is the trigger's doing. The
RECOMPUTED chain does not: both verifiers rebuild each `entryHash` from the
row's current columns with `actorUserId: row.userId`, and `actorUserId` is one
of the ten `HASH_FIELDS`, so a row hashed while `userId` held the subject no
longer recomputes once `userId` is NULL. A lawful erasure produced `valid:
false` at the first pseudonymized row — the exact signature the product uses to
prove tampering (issue #2682).

The repair, decided by the repo owner on 2026-09-20: **record the erasure in
the chain, and have the verifier consult the record.** `eraseUser` writes an
`ERASURE_EXECUTED` audit entry — one per tenant whose chain it touched, in the
SAME transaction as the pseudonymization — naming each affected `AuditLog.id`
together with the hash that row recomputes to once `userId` is NULL.
`verifyAuditChain` and `verifyTenantChain` excuse a mismatch only for a named
row whose recomputation equals that committed value, and both report the count
in `toleratedPseudonymizations` so a green verification still says how many
rows were erased.

Three properties make that safe rather than a verifier taught to look away, and
each is asserted by a live-tampering test in
`tests/integration/dsar-erasure-audit-survival.test.ts`:

- **The tolerance is `userId`-only.** The recorded hash commits to the row's
  nine other hashed fields, so any other edit to a named row changes the
  recomputation and the tolerance refuses it.
- **An un-named row gets nothing.** The trigger permits `userId` value → NULL,
  which is precisely the mutation an attacker can make; a `userId` nulled on a
  row no erasure entry names still breaks the chain.
- **The record is not privileged.** It is an `AuditLog` row inside the same
  chain, so forging it breaks the chain at the record — there is no second
  source of truth outside the chain's protection. That argument holds only for
  a HASHED record, so both verifiers read tolerances only from the hashed rows
  they actually walk: `AuditLog.entryHash` is nullable, `logAudit` and the
  lifecycle jobs still write unhashed rows with a caller-supplied `action`, and
  an unhashed record is one the walk never recomputes — it could never break,
  so it may never excuse.

The record identifies nobody: the entry carries `userId: null` and `actorType:
JOB`, and the hashes it stores are computed with `actorUserId: null`, so they
are a function of the post-erasure row alone. Rows whose stored hash did not
recompute BEFORE the erasure get no tolerance recorded, so an already-broken
chain stays broken through an erasure rather than being laundered by one; the
count of those appears in the entry as `rowsWithoutTolerance`. The mechanism
and its security argument live in `src/lib/audit/erasure-record.ts`.

**How this is enforced.** Behaviourally, in the `erasure pseudonymizes the audit
trail` block of `tests/guardrails/dsar-workflow-coverage.test.ts`: it RUNS
`eraseUser` against the in-memory probe in `tests/helpers/dsar-erasure-probe.ts`
and grades the operations it issued and the rows it left behind. It does not read
this document, and it does not read the source of `dsar-erasure.ts` — the
assertion it replaced (#2287) was satisfied by a JSDoc paragraph saying the right
words while the code did nothing of the kind. Since Stage 3 the grading is LIVE
rather than pinned: the run reports `EXECUTED` and the `B.` cases assert the rows
survived, carry a NULL `userId` for the subject only, and kept their hash chain.
The `A1`/`A2` tripwire that asserted the stub was still a stub is gone — its
failure was the handshake, and it was deleted in the same commit that
implemented the function. The oracle's own ability to discriminate is proved
separately, by driving deliberately broken synthetic implementations through the
same harness (`C1`–`C9`).

Order and atomicity are covered by `tests/unit/dsar-erasure-execute.test.ts`,
which the probe cannot reach: its client never fails, so it cannot see that the
pseudonymization must precede the hard delete (`AuditLog.userId` is ON DELETE SET
NULL, so deleting first would let the FK action do it and leave the receipt
reporting zero), nor that a hard delete refused by an ON DELETE RESTRICT
reference must roll the pseudonymization back with it — the trigger permits
value → NULL and nothing else, so a half-run erasure cannot be undone.

The DB-level half of the invariant (the `IMMUTABLE_AUDIT_LOG` trigger and the
`REVOKE`) is covered by `tests/integration/audit-immutability.test.ts` and
`tests/guards/audit-immutability-guardrails.test.ts`. That second file's Prisma
UPDATE scan carries exactly one exemption — this erasure module — and the test
beside it asserts the exemption is load-bearing and narrow: UPDATE verbs only,
one call, inside the erasure transaction, writing the one column the trigger
permits.

## Export bundle contents

The Stage 2 bundle (`EXPORT_BUNDLE_FILES` in `dsar-export.ts`), produced under a
one-time-use prefix in the evidence S3 bucket with a 7-day signed URL:

- `user.json` — the User row, all fields.
- `tenants.json` — each tenant the user is a member of (their membership row, not
  the tenant's data).
- `sessions.json` — `UserSession` history.
- `audit-log-as-actor.json` — every `AuditLog` entry where the user is the actor.
- `authored-content/` — Risk descriptions, Task comments, etc. they wrote
  (decrypted via the per-tenant DEK — it is the user's data).
- `metadata.json` — version, timestamp, request id, signed checksum.

## What happens to authored content

Content the user **authored** (Risk descriptions, Task comments, evidence they
uploaded) is **preserved**, not deleted — re-attributed to a "former user". The
user wrote it *as a user of the platform*; the platform retains operational
records of platform activity (audit, compliance) after the user is erased. The
erasure flow distinguishes **PII identifying the user** (erased / pseudonymized)
from **data they authored** (retained, attribution anonymized). Only the former
is in scope for Art. 17.
