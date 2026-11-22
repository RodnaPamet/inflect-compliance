# 2026-11-14 — DSAR erasure refuses up front (#5595)

**Commit:** `fix(dsar): erasure refuses a user referenced from the immutable audit tables (#5595)`

## Design

Owner decision on #5595: **refuse up front.** A user that an immutable or
stamped record names cannot be erased; the erasure says so before it writes
anything, instead of pseudonymizing, failing on a trigger or CHECK during the
`DELETE FROM "User"`, and rolling back, while `planErasure` had reported
`wouldSucceed: true`.

```
eraseUser(userId)
  └─ $transaction
       ├─ user.findUnique              (visibility control, unchanged)
       ├─ planErasure(userId, tx)      NEW — SELECTs only
       │     blockers? ──► throw ErasureBlockedError (409, blockers + reason)
       ├─ auditLog.findMany / updateMany   (pseudonymize, unchanged)
       ├─ appendAuditEntryWithin       (ERASURE_EXECUTED, unchanged)
       └─ user.delete                  (RESTRICT FKs still refuse a late blocker → rollback)
```

Three layers say the same thing:

1. **Schema.** Nine `User` FKs moved from `SET NULL` to `RESTRICT`, in
   `20261114140000_dsar_erasure_audit_references_restrict`.
2. **Plan.** `IMMUTABLE_USER_REFERENCES` names the same nine with a reason, and
   `planErasure` reports them as `BLOCKS_DELETE` whatever action the catalog
   reports. Every blocker carries a `reason`
   (`IMMUTABLE_AUDIT_TRAIL` / `STAMPED_DECISION_ACTOR` / `RESTRICT_REFERENCE`).
3. **Erasure.** `eraseUser` refuses on any blocker before its first write.

## Files

| File | Role |
|------|------|
| `prisma/migrations/20261114140000_dsar_erasure_audit_references_restrict/migration.sql` | Drops and re-adds the nine FKs as `ON DELETE RESTRICT` |
| `prisma/schema/{audit-trail,auth,controls,risk}.prisma` | `onDelete: Restrict` on the same nine relations |
| `src/app-layer/jobs/dsar-erasure.ts` | `ErasureBlockReason`, `IMMUTABLE_USER_REFERENCES`, `reason` on every reference, `ErasureBlockedError`, the up-front plan in `eraseUserWithin` |
| `tests/integration/dsar-erasure-audit-references.test.ts` | Real DB: the nine are RESTRICT; an `OrgAuditLog` target/actor is a blocker; the erasure refuses with nothing written; a raw delete is an FK refusal; a free subject still erases |
| `tests/integration/dsar-erasure-rollback.test.ts` | The rollback is now driven by a blocker committed after the plan; the up-front refusal is its own case |
| `tests/integration/dsar-erasure-audit-survival.test.ts`, `tests/guardrails/dsar-workflow-coverage.test.ts`, `tests/helpers/dsar-erasure-probe.ts`, `tests/unit/dsar-erasure-*.test.ts` | Grade the plan's reads as SELECT-only and before any write; fakes answer the plan |
| `docs/dsar.md` | The refusal and its reasons |

## Decisions

- **Which FKs.** Read from `pg_catalog`, not from the issue: every `SET NULL`
  FK into `User` against the referencing table's UPDATE triggers and CHECKs.
  Nine collide. `OrgAuditLog` (trigger refuses every UPDATE; both columns are
  hashed). `AccessReviewConnectedDecision.decidedByUserId` (one-way trigger).
  `AccessReviewDecision.decidedByUserId` / `executedByUserId`,
  `ControlException.approvedByUserId` / `rejectedByUserId`,
  `RiskTreatmentPlan.completedByUserId`, `TreatmentMilestone.completedByUserId`
  (pair CHECKs). The other `SET NULL` FKs have triggers scoped to
  `tenantId`/`controlId` or an owner count, and no CHECK on the user column.
- **`AuditLog.userId` stays `SET NULL`.** Its trigger permits exactly
  value → NULL, and `eraseUser` pseudonymizes it with an `ERASURE_EXECUTED`
  record before the delete. Making it a blocker would refuse the erasure of
  everybody who ever acted.
- **The plan's list overrides the catalog, deliberately.** On a database where
  the migration has not run (an older schema under a newer image, a restore),
  those FKs are still `SET NULL` and the delete still fails part-way. The plan
  reports a blocker either way, so it never again predicts a success the delete
  refuses.
- **Every blocker refuses up front, not only the new nine.** "The plan says it
  succeeds" has to mean the delete succeeds; a refusal with nothing written is
  better than a rollback for a `TenantMembership` too. The RESTRICT FKs stay the
  enforcement for a blocking row committed after the plan's read, and that
  rollback path is still tested against real Postgres.
- **No behaviour that worked is lost.** On each of the nine, a non-NULL value
  already made the user's delete fail; it now fails as an FK refusal before any
  row is touched. The tenant purge never deletes `User`, so RESTRICT onto
  `User` cannot block it.
- **Not built:** pseudonymising `OrgAuditLog` or the stamped decisions. That was
  the alternative the owner considered and did not choose.
