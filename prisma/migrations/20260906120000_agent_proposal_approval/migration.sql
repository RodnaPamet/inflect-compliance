-- ═══════════════════════════════════════════════════════════════════
-- TIERED REVIEW + APPROVAL IMMUTABILITY on the agent proposal queue
-- (OWASP ASI09 — human-agent trust exploitation / automation bias)
--
-- The propose-not-commit queue's whole safety claim is "a human approved it".
-- Before this migration the database could not answer "which humans?" — the
-- proposal carried one `reviewedByUserId` that the next writer overwrote — so
-- four-eyes was not enforceable, only describable.
--
-- Two things land here:
--
--   1. "AgentProposal"."requiredApprovals" — the number of DISTINCT humans this
--      proposal needs, composed once at the propose seam by
--      `resolveApprovalRequirement` (src/lib/agentic/approval-tiering.ts) from
--      the pinned policy-card rung, the agent's scored risk tier and its
--      registered autonomy level, taking the STRICTEST of the three.
--   2. "AgentProposalApproval" — one row per human signature, with the
--      four-eyes rule and the immutability rule both expressed as database
--      constraints rather than as usecase code.
--
-- ── WHY THE RULES ARE IN THE DATABASE ───────────────────────────────
--
-- Counting approvals and then writing one is a read-then-write. Two concurrent
-- requests each read "one signature so far" and each write the second, and the
-- proposal commits with one human's consent recorded as two. There is no
-- application-layer arrangement of that check that closes the window; there is
-- a unique index that never opens one.
--
-- ── ROLLING-DEPLOY SAFETY ───────────────────────────────────────────
--
--   • No `ALTER TYPE`. `AiHumanOutcome` already exists (the AI decision log's
--     Art 14 stamp) and is REUSED rather than a parallel enum minted.
--   • The new column is NULLABLE with no default, so the ALTER does not rewrite
--     "AgentProposal" and old containers keep writing rows that omit it.
--   • A NULL requirement reads as 2 everywhere — in `approval-tiering.ts` as
--     `UNKNOWN_REQUIREMENT_APPROVALS` and in the trigger below as a COALESCE.
--     Deliberately NOT backfilled to 1: every proposal already queued was
--     composed under no requirement at all, and an uncomputed requirement must
--     fail toward the expensive answer. In-flight proposals become
--     two-approver proposals on deploy. That is the control working.
--   • A container running the OLD image still approves through the old
--     single-reviewer path and writes no signature row. That gap closes when
--     the last old container drains; it is inherent to adding any gate, and it
--     fails in the pre-existing direction rather than a new one.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) The pinned requirement on the proposal ──────────────────────

ALTER TABLE "AgentProposal" ADD COLUMN IF NOT EXISTS "requiredApprovals" INTEGER;

-- A requirement below one would mean "commits with nobody looking", which is
-- not a state `approvalsRequiredFor` can produce. The CHECK is the backstop for
-- the paths the usecase does not own — a script, a migration, a hand-edited row.
ALTER TABLE "AgentProposal"
    ADD CONSTRAINT "AgentProposal_required_approvals_positive"
    CHECK ("requiredApprovals" IS NULL OR "requiredApprovals" >= 1);

-- The composite parent key an approval's FK points at, so a signature can never
-- be attached to another tenant's proposal.
--
-- `IF NOT EXISTS`, deliberately. This composite parent key is not private to
-- this change: ANY table that wants a tenant-safe composite FK back to
-- "AgentProposal" needs exactly this index under exactly this name, and two
-- migrations adding it unconditionally means whichever merges second fails with
-- 42P07 on deploy. The index is idempotent by construction — same columns, same
-- name, same uniqueness — so creating it conditionally is not papering over a
-- conflict, it is stating that the key belongs to the table rather than to one
-- migration. (Observed for real: a sibling branch had already created it in the
-- shared test database.)
CREATE UNIQUE INDEX IF NOT EXISTS "AgentProposal_id_tenantId_key"
    ON "AgentProposal"("id", "tenantId");

-- ─── 2) The signature table ─────────────────────────────────────────

CREATE TABLE "AgentProposalApproval" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "proposalId"        TEXT NOT NULL,
    "approverUserId"    TEXT NOT NULL,
    "outcome"           "AiHumanOutcome" NOT NULL DEFAULT 'PENDING',
    "requiredApprovals" INTEGER NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentProposalApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentProposalApproval"
    ADD CONSTRAINT "AgentProposalApproval_required_approvals_positive"
    CHECK ("requiredApprovals" >= 1);

-- THE FOUR-EYES CONSTRAINT ITSELF. One signature per human per proposal,
-- arbitrated by the index, with no read-then-write window anywhere.
CREATE UNIQUE INDEX "AgentProposalApproval_tenantId_proposalId_approverUserId_key"
    ON "AgentProposalApproval"("tenantId", "proposalId", "approverUserId");

CREATE INDEX "AgentProposalApproval_tenantId_proposalId_idx"
    ON "AgentProposalApproval"("tenantId", "proposalId");

ALTER TABLE "AgentProposalApproval"
    ADD CONSTRAINT "AgentProposalApproval_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentProposalApproval"
    ADD CONSTRAINT "AgentProposalApproval_proposalId_tenantId_fkey"
    FOREIGN KEY ("proposalId", "tenantId") REFERENCES "AgentProposal"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3) The four-eyes trigger: not the agent's own owner ────────────
--
-- `RegisteredAgent.ownerUserId` is the accountable human for the agent. The
-- register's own schema comment says that column exists for "the two-person rule
-- downstream, which needs a value it can compare rather than a maybe-null it has
-- to guess about". This is downstream.
--
-- THE RULE IS A SET PROPERTY — "the owner is not AMONG the approvers" — and not
-- the ordinal "the SECOND approver is not the owner". They sound equivalent and
-- are not: with signatures {owner, other}, which one is "the second" is decided
-- by insertion order, and insertion order is chosen by whoever clicks first. An
-- ordering-dependent four-eyes rule is bypassed by controlling the ordering. The
-- set form cannot be, and it strictly implies the ordinal one.
--
-- It applies ONLY when the proposal needs two signatures. On a single-approver
-- proposal the owner may sign: the register names an accountable human, and a
-- rule barring them everywhere would make a one-admin tenant unable to approve
-- anything — a control shaped like an outage is a control people remove.
--
-- Fired on INSERT **and** UPDATE. The immutability trigger permits `PENDING` →
-- terminal, so an owner who inserted a PENDING row could otherwise stamp it into
-- a counting signature on the second statement.
--
-- No `USING ERRCODE`, deliberately, for the reason the policy-card pin trigger
-- states: this fires on the ordinary typed Prisma path, and a mapped SQLSTATE
-- reaches the caller as a foreign-key message about a foreign key that does not
-- exist. Left at P0001 the text survives, and the usecase matches on it.

CREATE OR REPLACE FUNCTION agent_proposal_approval_four_eyes()
RETURNS TRIGGER AS $$
DECLARE
    v_required INTEGER;
    v_owner    TEXT;
BEGIN
    -- A row that is not (yet) an approving outcome grants nothing, so there is
    -- nothing to arbitrate. REJECTED is deliberately unrestricted: refusing a
    -- proposal is the safe direction, and an owner who cannot reject their own
    -- agent's bad proposal is a control pointing the wrong way.
    IF NEW."outcome" NOT IN ('ACCEPTED', 'EDITED') THEN
        RETURN NEW;
    END IF;

    SELECT COALESCE(p."requiredApprovals", 2), a."ownerUserId"
      INTO v_required, v_owner
      FROM "AgentProposal" p
      LEFT JOIN "RegisteredAgent" a
        ON a."id" = p."agentId" AND a."tenantId" = p."tenantId"
     WHERE p."id" = NEW."proposalId" AND p."tenantId" = NEW."tenantId";

    -- `FOUND`, not a sentinel variable: `SELECT ... INTO` sets every target to
    -- NULL when it matches nothing, so a `v_found BOOLEAN` would come back NULL
    -- and `IF NOT v_found` would be NULL — neither true nor false — and the
    -- refusal below would be skipped for exactly the case it exists for.
    IF NOT FOUND THEN
        -- A signature on a proposal this session cannot see. Under `app_user`
        -- that is a cross-tenant write attempt (RLS hid the row); under a
        -- privileged session it is a dangling id. Both refuse.
        RAISE EXCEPTION
            'AGENT_PROPOSAL_APPROVAL_NO_PROPOSAL: no visible proposal % in tenant %.',
            NEW."proposalId", NEW."tenantId";
    END IF;

    IF v_required >= 2 AND v_owner IS NOT NULL AND NEW."approverUserId" = v_owner THEN
        RAISE EXCEPTION
            'AGENT_PROPOSAL_APPROVAL_OWNER_SELF_REVIEW: proposal % needs % '
            'independent approvers and % is the registered owner of the agent '
            'that proposed it. The accountable owner cannot be one of the '
            'humans who signs off their own agent''s work.',
            NEW."proposalId", v_required, NEW."approverUserId";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_approval_four_eyes_trg ON "AgentProposalApproval";
CREATE TRIGGER agent_proposal_approval_four_eyes_trg
    BEFORE INSERT OR UPDATE ON "AgentProposalApproval"
    FOR EACH ROW EXECUTE FUNCTION agent_proposal_approval_four_eyes();

-- ─── 4) The immutability trigger ────────────────────────────────────
--
-- Mirrors `ai_decision_log_immutable` column for column: every column except
-- `outcome` must be unchanged, and `outcome` may leave `PENDING` exactly once.
-- An approval that can be edited later is not evidence.
--
-- BEFORE-trigger firing order in Postgres is alphabetical by trigger name, so
-- `..._four_eyes_trg` runs before `..._immutable_trg`. Either order is correct
-- (both are pure refusals with no side effects); it is stated so a later rename
-- is a deliberate act rather than a surprise.

CREATE OR REPLACE FUNCTION agent_proposal_approval_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW."id", NEW."tenantId", NEW."proposalId", NEW."approverUserId",
           NEW."requiredApprovals", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."proposalId", OLD."approverUserId",
           OLD."requiredApprovals", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROPOSAL_APPROVAL: an approval is append-only; '
            'only outcome may transition, once, out of PENDING.';
    END IF;

    IF NEW."outcome" IS DISTINCT FROM OLD."outcome"
       AND OLD."outcome" <> 'PENDING' THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROPOSAL_APPROVAL: outcome is already recorded as '
            '%; an approval decision is stamped once and never revised.',
            OLD."outcome";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_approval_immutable_trg ON "AgentProposalApproval";
CREATE TRIGGER agent_proposal_approval_immutable_trg
    BEFORE UPDATE ON "AgentProposalApproval"
    FOR EACH ROW EXECUTE FUNCTION agent_proposal_approval_immutable();

-- ─── 4b) The REQUIREMENT is write-once too ──────────────────────────
--
-- A pinned requirement that can be lowered afterwards is not a requirement. The
-- four-eyes trigger above reads `COALESCE(p."requiredApprovals", 2)`, so an
-- UPDATE moving a proposal from 2 to 1 would turn off both halves of the rule —
-- the owner exclusion AND the second signature — leaving a queue that still
-- looks tiered from the outside.
--
-- Same shape and same reasoning as `agent_policy_card_pin_immutable_guard`
-- (which this table already carries for `policyCardVersion`): a blanket UPDATE
-- ban is impossible because the row legitimately moves through PENDING →
-- ACCEPTED and gains a `createdEntityId`, so immutability is enforced at COLUMN
-- level. NULL → value is permitted, and only that transition, so a future
-- backfill can fill a legacy row in without being able to rewrite one that
-- already answered.
--
-- A SEPARATE function rather than an extra branch in the pin guard, because that
-- one is shared with "WorkflowRun", which has no such column.

CREATE OR REPLACE FUNCTION agent_proposal_required_approvals_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."requiredApprovals" IS NOT NULL
       AND NEW."requiredApprovals" IS DISTINCT FROM OLD."requiredApprovals" THEN
        RAISE EXCEPTION
            'IMMUTABLE_REQUIRED_APPROVALS: proposal % was queued requiring % '
            'approvers and that is write-once. Lowering it would retire the '
            'four-eyes rule on a proposal already in front of reviewers.',
            OLD."id", OLD."requiredApprovals";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_required_approvals_immutable_trg ON "AgentProposal";
CREATE TRIGGER agent_proposal_required_approvals_immutable_trg
    BEFORE UPDATE ON "AgentProposal"
    FOR EACH ROW EXECUTE FUNCTION agent_proposal_required_approvals_immutable();

-- ─── 5) Privileges + RLS ────────────────────────────────────────────
--
-- The append-only property is enforced TWICE, the same split
-- `AgentPolicyCardVersion` and `AuditLog` make: `app_user` is granted neither
-- UPDATE nor DELETE, and the trigger above refuses an UPDATE from ANY role
-- including the owner. The grant is the everyday control; the trigger covers the
-- privileged paths (a migration, a script, a superuser session) that the grant
-- never would. Neither alone is the claim, so both are asserted in
-- `tests/integration/proposal-approval-immutability.test.ts`.
--
-- DELETE is withheld from `app_user` but NOT blocked by a trigger, unlike
-- AuditLog: an approval row is deleted only by CASCADE from its proposal or its
-- tenant — i.e. only when the thing it signs is itself gone — and a trigger
-- refusing that would make deleting a tenant impossible. Referential CASCADE
-- runs as the table owner and so is unaffected by the withheld grant.

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "AgentProposalApproval" TO app_user;
        REVOKE UPDATE, DELETE ON "AgentProposalApproval" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AgentProposalApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProposalApproval" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "AgentProposalApproval";
CREATE POLICY tenant_isolation ON "AgentProposalApproval"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProposalApproval";
CREATE POLICY tenant_isolation_insert ON "AgentProposalApproval"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "AgentProposalApproval";
CREATE POLICY superuser_bypass ON "AgentProposalApproval"
    USING (current_setting('role') != 'app_user');
