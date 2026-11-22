-- ═══════════════════════════════════════════════════════════════════
-- #5595 — a DSAR erasure REFUSES UP FRONT when the user is referenced from
-- an immutable audit table or a stamped decision.
--
-- Owner decision, 2026-11-14: "refuse up front". The user FKs below become
-- ON DELETE RESTRICT, `planErasure` reports them as blockers, and `eraseUser`
-- refuses before it writes anything. The audit chain is untouched. Erasing a
-- person who has audit history would need a pseudonymisation feature; that
-- was considered and not chosen now.
--
-- ─── The defect ─────────────────────────────────────────────────────
--
-- Each of these nine references was ON DELETE SET NULL, and on each of them a
-- SET NULL can only FAIL, part-way through the `DELETE FROM "User"`:
--
--   OrgAuditLog.actorUserId, .targetUserId
--       `org_audit_log_immutable` refuses EVERY UPDATE (20260430052807), and
--       both columns are hashed into the per-organization chain, so nulling
--       one would also break the chain at that row.
--   AccessReviewConnectedDecision.decidedByUserId
--       `access_review_connected_decision_one_way` refuses changing the
--       decider of a recorded decision (ACCESS_REVIEW_DECISION_STAMPED).
--   AccessReviewDecision.decidedByUserId, .executedByUserId
--       CHECKs `AccessReviewDecision_decided_pair` / `_executed_pair`
--       (20260507100000) pair each actor with its timestamp.
--   ControlException.approvedByUserId, .rejectedByUserId
--       CHECKs `ControlException_approval_shape` / `_expired_shape` /
--       `_rejection_shape` (20260507140000) require the actor beside the
--       stamp.
--   RiskTreatmentPlan.completedByUserId
--       CHECK `RiskTreatmentPlan_completion_shape`.
--   TreatmentMilestone.completedByUserId
--       CHECK `TreatmentMilestone_completion_pair`.
--
-- `planErasure` counted a SET NULL edge as non-blocking, so it reported
-- `wouldSucceed: true` for an erasure the database was going to refuse.
--
-- Found by reading every SET NULL FK into "User" against the referencing
-- table's UPDATE triggers and CHECK constraints in pg_catalog. The other
-- SET NULL references are unaffected: their triggers are column-scoped to
-- tenantId/controlId or count owners, and none of their CHECKs names the
-- user column. `AuditLog.userId` stays SET NULL on purpose — its trigger
-- permits exactly that shape (20260917130000) and `eraseUser` pseudonymizes
-- it explicitly, with an ERASURE_EXECUTED record, before the delete.
--
-- ─── What changes, and what does not ────────────────────────────────
--
-- Only the referential action. Same columns, same target, same ON UPDATE
-- CASCADE, same constraint names. No trigger, CHECK, row or hash moves.
--
-- No delete path that succeeded before fails now: on every one of these
-- columns a non-NULL value already made the user's delete fail (on the
-- trigger or the CHECK); it now fails earlier, as an FK refusal (SQLSTATE
-- 23503, Prisma P2003). The one theoretical exception is a connected
-- decision whose decider is set with no decision recorded — the trigger
-- would have let that one go NULL — and no writer produces it: both
-- writers of `decidedByUserId` there set it in the same UPDATE as the
-- decision (usecases/access-review-connected.ts, access-review-agent.ts).
-- The tenant purge never deletes "User" (it has no
-- tenantId), so RESTRICT onto "User" cannot block it.
--
-- Each table's DROP and ADD are one ALTER TABLE, so no statement boundary
-- exists at which the reference is unconstrained. The ADD re-validates
-- rows that the previous FK already held valid.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE "OrgAuditLog"
    DROP CONSTRAINT "OrgAuditLog_actorUserId_fkey",
    ADD CONSTRAINT "OrgAuditLog_actorUserId_fkey"
        FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    DROP CONSTRAINT "OrgAuditLog_targetUserId_fkey",
    ADD CONSTRAINT "OrgAuditLog_targetUserId_fkey"
        FOREIGN KEY ("targetUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccessReviewConnectedDecision"
    DROP CONSTRAINT "AccessReviewConnectedDecision_decidedByUserId_fkey",
    ADD CONSTRAINT "AccessReviewConnectedDecision_decidedByUserId_fkey"
        FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AccessReviewDecision"
    DROP CONSTRAINT "AccessReviewDecision_decidedByUserId_fkey",
    ADD CONSTRAINT "AccessReviewDecision_decidedByUserId_fkey"
        FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    DROP CONSTRAINT "AccessReviewDecision_executedByUserId_fkey",
    ADD CONSTRAINT "AccessReviewDecision_executedByUserId_fkey"
        FOREIGN KEY ("executedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ControlException"
    DROP CONSTRAINT "ControlException_approvedByUserId_fkey",
    ADD CONSTRAINT "ControlException_approvedByUserId_fkey"
        FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    DROP CONSTRAINT "ControlException_rejectedByUserId_fkey",
    ADD CONSTRAINT "ControlException_rejectedByUserId_fkey"
        FOREIGN KEY ("rejectedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiskTreatmentPlan"
    DROP CONSTRAINT "RiskTreatmentPlan_completedByUserId_fkey",
    ADD CONSTRAINT "RiskTreatmentPlan_completedByUserId_fkey"
        FOREIGN KEY ("completedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TreatmentMilestone"
    DROP CONSTRAINT "TreatmentMilestone_completedByUserId_fkey",
    ADD CONSTRAINT "TreatmentMilestone_completedByUserId_fkey"
        FOREIGN KEY ("completedByUserId") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
