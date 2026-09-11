# Data Subject Access Requests (DSAR)

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md). DSAR is
> the compliance-driven flip side of [`docs/data-retention.md`](data-retention.md)
> (what we keep) — it is how a data subject exercises GDPR Art. 15 (access/export)
> and Art. 17 (erasure).

## Scope of this document — Stage 1 (foundation)

This ships the **foundation**, not the full feature. DSAR is a multi-PR sequence
(each PR carries the `dsar` prefix):

| Stage | Scope | Status |
|-------|-------|--------|
| **1 — Foundation** | `DataSubjectRequest` model + migration, the workflow state machine, rejection criteria, cooling-off + verification constants, the export/erasure job skeletons (NOT executing), this doc, the ratchet. | **this PR** |
| 2 — Export pipeline | Produce the bundle (decrypt authored content, write to S3, 7-day signed URL, email). Reversible → sequenced first. | follow-up |
| 3 — Erasure pipeline | The irreversible cascade + the `IMMUTABLE_AUDIT_LOG` trigger change to permit pseudonymization. Validated in staging behind a flag. | follow-up |
| 4 — Admin UI + rollout | `/admin/dsar-requests` (`admin.compliance_dsar`), monitoring, production flag flip. | follow-up |

The export + erasure jobs (`src/app-layer/jobs/dsar-export.ts`,
`dsar-erasure.ts`) exist with their contracts + safety guards but **throw if
called** and are **not registered** with the scheduler — execution is off.

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

So the action is retained; the identifying `userId` is removed. The Stage 3 PR
adds the narrow trigger condition that permits this one UPDATE path while still
refusing every other `AuditLog` UPDATE.

**How this is enforced.** Behaviourally, in the `erasure pseudonymizes the audit
trail` block of `tests/guardrails/dsar-workflow-coverage.test.ts`: it RUNS
`eraseUser` against the in-memory probe in `tests/helpers/dsar-erasure-probe.ts`
and grades the operations it issued and the rows it left behind. It does not read
this document, and it does not read the source of `dsar-erasure.ts` — the
assertion it replaced (#2287) was satisfied by a JSDoc paragraph saying the right
words while the code did nothing of the kind. Today the run reports `REFUSED`
(the Stage-1 stub), so the grading is *pinned, not exercised*; the oracle's
ability to discriminate is proved separately against synthetic implementations.
The day erasure starts doing work, `A1`/`A2` go red — that failure is the
handshake for the Stage 3 author: replace those two, do not relax them, and the
grading becomes live. The DB-level half of the invariant (the
`IMMUTABLE_AUDIT_LOG` trigger refusing both UPDATE and DELETE on `AuditLog`,
which Stage 3 must narrow rather than drop) is covered by
`tests/integration/audit-immutability.test.ts`.

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
