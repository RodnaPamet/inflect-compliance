-- #3760 (follow-up of 3d, #3677) — THE DISSENTER NEVER DECIDES THEIR OWN DISSENT'S
-- PROPOSAL, held by the database as well as the usecase.
--
-- 3d puts the bar in `assertNotDissentAuthor` (`usecases/agent-proposals.ts`),
-- on approve, approve-with-edits, reject and bulk reject. That refusal fires
-- first and writes its `AUTHZ_DENIED` row. These triggers are the backstop for
-- every writer that does not go through it — a raw `updateMany`, a new deciding
-- path that forgot the call — under every role, `app_user` included.
--
-- A dissent's FINDING proposal carries its review in the plain column
-- `AgentProposal.proposedBySessionRef` = 'audit-workpaper-review:<reviewId>'
-- (`dissentProposalOriginRef`). The review's `reviewedByUserId` is the
-- dissenter. Three refusals, with the usecase's reason codes:
--
--   1. an approval SIGNATURE by the dissenter (`AgentProposalApproval` insert);
--   2. a DECISION by the dissenter — PENDING to ACCEPTED, EDITED or REJECTED with
--      `reviewedByUserId` the dissenter (`AgentProposal` update);
--   3. a decision or signature on a proposal whose ref names no review this
--      tenant holds (DISSENT_AUTHOR_UNKNOWN): nobody can then be shown not to be
--      its author.
--
-- And one more, without which the other three could be stepped round: the ref
-- of a dissent's proposal is WRITE-ONCE. An UPDATE that changes or clears it
-- first and decides afterwards would otherwise pass both triggers.
--
-- Cost: a proposal whose ref does not carry the prefix pays one string
-- comparison and nothing else. A dissent's proposal pays one primary-key read.
--
-- Additive and idempotent (CREATE OR REPLACE / DROP TRIGGER IF EXISTS). No
-- table, column or row changes.

-- ─── The dissenter of a proposal, or NULL when it is not a dissent's ───────
--
-- Returns the review's `reviewedByUserId`. Raises DISSENT_AUTHOR_UNKNOWN when
-- the ref carries the prefix but names no review of this tenant: under
-- `app_user` that is a review RLS hides (another tenant's), and under a
-- privileged session a dangling id. Both refuse.
CREATE OR REPLACE FUNCTION agent_proposal_dissent_author(p_tenant TEXT, p_ref TEXT)
RETURNS TEXT AS $$
DECLARE
    v_prefix CONSTANT TEXT := 'audit-workpaper-review:';
    v_review_id TEXT;
    v_author TEXT;
BEGIN
    IF p_ref IS NULL OR left(p_ref, length(v_prefix)) <> v_prefix OR length(p_ref) = length(v_prefix) THEN
        RETURN NULL;
    END IF;
    v_review_id := substr(p_ref, length(v_prefix) + 1);

    SELECT r."reviewedByUserId"
      INTO v_author
      FROM "AuditWorkpaperSampleReview" r
     WHERE r."id" = v_review_id AND r."tenantId" = p_tenant;

    -- `FOUND`, not the variable: a review with no answer yet has a NULL
    -- reviewer, and that must not read as "no such review".
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'DISSENT_AUTHOR_UNKNOWN: the proposal''s origin names review %, which '
            'tenant % does not hold, so nobody can be shown not to be its author.',
            v_review_id, p_tenant;
    END IF;
    RETURN v_author;
END;
$$ LANGUAGE plpgsql;

-- ─── 1. An approval signature by the dissenter ─────────────────────────────
CREATE OR REPLACE FUNCTION agent_proposal_approval_dissent_author_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_ref TEXT;
    v_author TEXT;
BEGIN
    SELECT p."proposedBySessionRef"
      INTO v_ref
      FROM "AgentProposal" p
     WHERE p."id" = NEW."proposalId" AND p."tenantId" = NEW."tenantId";
    -- A proposal this session cannot see is the four-eyes trigger's refusal
    -- (AGENT_PROPOSAL_APPROVAL_NO_PROPOSAL); nothing to add here.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    v_author := agent_proposal_dissent_author(NEW."tenantId", v_ref);
    IF v_author IS NOT NULL AND NEW."approverUserId" = v_author THEN
        RAISE EXCEPTION
            'DISSENT_AUTHOR_MAY_NOT_DECIDE: % dissented in the review that raised '
            'proposal %, and may not sign its approval.',
            NEW."approverUserId", NEW."proposalId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_approval_dissent_author_trg ON "AgentProposalApproval";
CREATE TRIGGER agent_proposal_approval_dissent_author_trg
    BEFORE INSERT OR UPDATE ON "AgentProposalApproval"
    FOR EACH ROW EXECUTE FUNCTION agent_proposal_approval_dissent_author_guard();

-- ─── 2–4. A decision by the dissenter, and the write-once ref ──────────────
CREATE OR REPLACE FUNCTION agent_proposal_dissent_author_guard()
RETURNS TRIGGER AS $$
DECLARE
    v_prefix CONSTANT TEXT := 'audit-workpaper-review:';
    v_author TEXT;
BEGIN
    -- The ref of a dissent's proposal is write-once: changed or cleared, the
    -- decision below could no longer find the dissenter.
    IF OLD."proposedBySessionRef" IS NOT NULL
       AND left(OLD."proposedBySessionRef", length(v_prefix)) = v_prefix
       AND NEW."proposedBySessionRef" IS DISTINCT FROM OLD."proposedBySessionRef" THEN
        RAISE EXCEPTION
            'DISSENT_ORIGIN_IMMUTABLE: proposal % was raised by a workpaper dissent '
            '(%), and its origin ref is written once.',
            OLD."id", OLD."proposedBySessionRef";
    END IF;

    -- Only a DECISION is judged: PENDING to ACCEPTED, EDITED or REJECTED.
    -- Expiry, quarantine and every other move are not a person deciding.
    IF OLD."status" = 'PENDING'
       AND NEW."status" IN ('ACCEPTED', 'EDITED', 'REJECTED') THEN
        v_author := agent_proposal_dissent_author(NEW."tenantId", NEW."proposedBySessionRef");
        IF v_author IS NOT NULL AND NEW."reviewedByUserId" = v_author THEN
            RAISE EXCEPTION
                'DISSENT_AUTHOR_MAY_NOT_DECIDE: % dissented in the review that raised '
                'proposal %, and may not decide it (%).',
                NEW."reviewedByUserId", NEW."id", NEW."status";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_proposal_dissent_author_trg ON "AgentProposal";
CREATE TRIGGER agent_proposal_dissent_author_trg
    BEFORE UPDATE ON "AgentProposal"
    FOR EACH ROW EXECUTE FUNCTION agent_proposal_dissent_author_guard();
