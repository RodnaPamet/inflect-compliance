-- Epic Agentic 5 — PINNING the policy-card version onto the runtime records.
--
-- `AgentProposal` and `WorkflowRun` are what an autonomous agent leaves behind.
-- 1/10 added `agentId` to both, so every runtime row resolves to the register.
-- This adds the second half of that attribution: not only WHICH agent, but under
-- WHICH VERSION OF ITS DECLARED POLICY the row was produced.
--
-- Without it, reconstructing an incident means reading the card as it is TODAY
-- and hoping nobody edited it — and somebody editing it is precisely what an
-- incident review is looking for. `AgentPolicyCardVersion` is already immutable
-- (no `app_user` UPDATE privilege plus a trigger); this makes the reference to
-- one immutable too, so the pair is evidence rather than a pointer into
-- rewritable state.
--
-- ─── THREE STATES, DELIBERATELY, IN ONE NULLABLE COLUMN ─────────────
--
--   NULL  — the row predates pinning. We do not know what was in force.
--   0     — the pin WAS resolved and no card was in force: the agent has none,
--           or the row came from a human-started run or the in-product
--           assistant. `NO_POLICY_CARD` in `src/lib/agentic/policy-card.ts`.
--   >= 1  — the version that authorized the call which produced the row.
--
-- "Not recorded" and "recorded as none" are different facts and an absence that
-- means both is an absence nobody can act on. 0 is safe as the sentinel because
-- `AgentPolicyCardVersion_version_positive` already CHECKs a real version at
-- >= 1, so the two value spaces cannot meet.
--
-- The migration deliberately does NOT backfill. Every existing row genuinely
-- predates the pin, and writing 0 across them would assert something nobody
-- checked — the same reasoning `onPremStateObservedAt` recorded when it left its
-- rows NULL rather than inventing an observation.

-- ─── Columns ────────────────────────────────────────────────────────
ALTER TABLE "AgentProposal" ADD COLUMN "policyCardVersion" INTEGER;
ALTER TABLE "WorkflowRun"   ADD COLUMN "policyCardVersion" INTEGER;

-- The sentinel and the version space, kept apart at the database.
ALTER TABLE "AgentProposal"
    ADD CONSTRAINT "AgentProposal_policy_card_pin_range"
    CHECK ("policyCardVersion" IS NULL OR "policyCardVersion" >= 0);
ALTER TABLE "WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_policy_card_pin_range"
    CHECK ("policyCardVersion" IS NULL OR "policyCardVersion" >= 0);

-- ═══════════════════════════════════════════════════════════════════
-- The pin is WRITE-ONCE
-- ═══════════════════════════════════════════════════════════════════
-- A blanket UPDATE ban is impossible here and that is the whole design problem:
-- both tables are updated constantly on the ordinary path — a run moves through
-- RUNNING → AWAITING_APPROVAL → COMPLETED and rewrites `stepCount`,
-- `contextJson` and `summary`; a proposal moves to APPROVED and gains
-- `createdEntityId`. So immutability is enforced at COLUMN level: once the pin
-- holds a value it may not change, and it may not be set back to NULL.
--
-- NULL → value is permitted, and only that transition. It is what lets a future
-- backfill (or a write path that learns the version late) fill a row in without
-- being able to rewrite one that already answered.
--
-- Enforced for EVERY role, not by privilege. Unlike the version table — whose
-- append-only property can be expressed as "app_user holds no UPDATE" because it
-- is never legitimately updated — these two tables need UPDATE for their normal
-- work, so a privilege cannot separate the pin from the rest of the row. A
-- BEFORE UPDATE trigger can, and it covers the privileged paths (a migration, a
-- script, a superuser session) that a privilege never would.
--
-- ─── WHY NO `USING ERRCODE = 'restrict_violation'` HERE ─────────────
--
-- The sibling trigger on "AgentPolicyCardVersion" raises with that SQLSTATE
-- (23001), and so do the AuditLog / OrgAuditLog immutability triggers. This one
-- deliberately does not, and the difference is which client sees it.
--
-- Those tables are never updated through the typed Prisma client at all — the
-- repository has no update method, and `app_user` holds no UPDATE privilege — so
-- their trigger is only ever hit by raw SQL, which surfaces the message intact.
-- This trigger fires on `prisma.workflowRun.update(...)`, the ordinary typed
-- path, and Prisma maps 23001 to P2003, whose message is "Foreign key constraint
-- violated on the (not available)". The text above never reaches the caller and
-- the reader is sent to look for a foreign key that has nothing to do with it.
--
-- Left at the default (P0001, raise_exception), Prisma has no mapping and passes
-- the message through. A refusal that does not say what refused is the same
-- defect this whole subsystem keeps naming, one layer down.
CREATE OR REPLACE FUNCTION agent_policy_card_pin_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."policyCardVersion" IS NOT NULL
       AND NEW."policyCardVersion" IS DISTINCT FROM OLD."policyCardVersion" THEN
        RAISE EXCEPTION
            'IMMUTABLE_POLICY_CARD_PIN: %.policyCardVersion is write-once and is '
            'already %. A run or proposal records the policy-card version that '
            'was in force when it executed; rewriting it would reconstruct '
            'today''s rules wearing an old version number.',
            TG_TABLE_NAME, OLD."policyCardVersion";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_policy_card_pin_immutable ON "AgentProposal";
CREATE TRIGGER agent_proposal_policy_card_pin_immutable
    BEFORE UPDATE ON "AgentProposal"
    FOR EACH ROW
    EXECUTE FUNCTION agent_policy_card_pin_immutable_guard();

DROP TRIGGER IF EXISTS workflow_run_policy_card_pin_immutable ON "WorkflowRun";
CREATE TRIGGER workflow_run_policy_card_pin_immutable
    BEFORE UPDATE ON "WorkflowRun"
    FOR EACH ROW
    EXECUTE FUNCTION agent_policy_card_pin_immutable_guard();
