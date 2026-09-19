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
| 3 — Erasure pipeline | The irreversible cascade, plus the `IMMUTABLE_AUDIT_LOG` trigger narrowing that permits pseudonymization. | **cascade + trigger shipped, unmounted** |
| 4 — Admin UI + rollout | `/admin/dsar-requests` (`admin.compliance_dsar`), monitoring, production rollout. | open |

**Stage 3's `eraseUser` EXECUTES — and nothing calls it.** The distinction is
the whole safety posture, so it is worth stating both halves plainly. The
function in `src/app-layer/jobs/dsar-erasure.ts` performs the real cascade
against the client it is given: it is no longer a stub that throws. It is also
absent from `register-schedules` and `executor-registry`, and no route, usecase
or job in `src/` calls it — so no scheduler fires it and no request reaches it.
Giving it an operator entry point (who may run it, for which subject, with what
audit record) is a separate decision that has not been taken.

`dsar-export.ts` is unchanged: it still throws if called and is still
unregistered.

Its sibling `planErasure`, in the same module, is the **dry run** — it reports
which references would refuse the Stage 2 hard delete for a given subject, and
writes nothing (`writes: 0`, asserted by capturing every statement it issues).
It is likewise unmounted.

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
