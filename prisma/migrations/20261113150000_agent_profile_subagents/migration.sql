-- #4594 (Step 2e, pull request C) — INLINE SUB-AGENTS IN A PROFILE VERSION.
--
-- "Delegation → 1. The model" in docs/claude-tool-runner-design.md is the
-- design. A version may carry up to four sub-agents, each a name, its own
-- instructions, a subset of the version's tools and skills, and a turn limit.
-- They are data on the version, so they inherit its lifecycle, its four-eyes
-- approval and its content hash.
--
-- ─── 1. The column: canonical JSON, encrypted, never empty ──────────
--
-- `subagentsJson` is canonical JSON of a checked list
-- (`src/lib/agentic/agent-profile.ts`), or NULL for a version with none, which
-- is every version that exists today. An empty list is stored as NULL, never
-- as `[]`, and the CHECK refuses the empty string. Encrypted at rest (Epic B):
-- the instructions in it are the tenant's own words.

ALTER TABLE "AgentProfileVersion" ADD COLUMN "subagentsJson" TEXT;

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_subagents_json_present"
    CHECK ("subagentsJson" IS NULL OR char_length("subagentsJson") > 0);

-- ─── 2. The freeze, REPLACED IN THE SAME MIGRATION ──────────────────
--
-- The lifecycle function freezes the columns it lists, so a column it does not
-- list could be rewritten on an approved version. It is replaced here, with
-- `subagentsJson` added to the rotation sweeps' re-wrap exception (ciphertext
-- to `v2:` ciphertext, every other column unchanged) and to the frozen
-- columns. Every rule of 20261112100000_agent_profile_flow is unchanged.

CREATE OR REPLACE FUNCTION agent_profile_version_lifecycle()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                'AGENT_PROFILE_VERSION_STARTS_AT_DRAFT: a version is created as a '
                'DRAFT and reaches review only by being submitted.';
        END IF;
        IF NEW."rejectionReason" IS NOT NULL THEN
            RAISE EXCEPTION
                'AGENT_PROFILE_REJECTION_REASON_WITH_REJECTION: a reason is written '
                'when the version is rejected, not before.';
        END IF;
        RETURN NEW;
    END IF;

    -- The rotation sweeps' re-wrap: only the encrypted columns change, each
    -- from ciphertext to v2 ciphertext.
    IF (NEW."instructions" IS DISTINCT FROM OLD."instructions"
        OR NEW."rejectionReason" IS DISTINCT FROM OLD."rejectionReason"
        OR NEW."flowJson" IS DISTINCT FROM OLD."flowJson"
        OR NEW."subagentsJson" IS DISTINCT FROM OLD."subagentsJson")
       AND (to_jsonb(NEW) - 'instructions' - 'rejectionReason' - 'flowJson' - 'subagentsJson')
           = (to_jsonb(OLD) - 'instructions' - 'rejectionReason' - 'flowJson' - 'subagentsJson')
       AND (NEW."instructions" IS NOT DISTINCT FROM OLD."instructions"
            OR (OLD."instructions" ~ '^v[12]:' AND NEW."instructions" ~ '^v2:'))
       AND (NEW."rejectionReason" IS NOT DISTINCT FROM OLD."rejectionReason"
            OR (OLD."rejectionReason" ~ '^v[12]:' AND NEW."rejectionReason" ~ '^v2:'))
       AND (NEW."flowJson" IS NOT DISTINCT FROM OLD."flowJson"
            OR (OLD."flowJson" ~ '^v[12]:' AND NEW."flowJson" ~ '^v2:'))
       AND (NEW."subagentsJson" IS NOT DISTINCT FROM OLD."subagentsJson"
            OR (OLD."subagentsJson" ~ '^v[12]:' AND NEW."subagentsJson" ~ '^v2:'))
    THEN
        RETURN NEW;
    END IF;

    IF NEW."instructions" IS DISTINCT FROM OLD."instructions" THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s instructions never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF NEW."flowJson" IS DISTINCT FROM OLD."flowJson" THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s flow never changes; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF NEW."subagentsJson" IS DISTINCT FROM OLD."subagentsJson" THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s sub-agents never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF NEW."rejectionReason" IS DISTINCT FROM OLD."rejectionReason"
       AND NOT (OLD."rejectionReason" IS NULL AND OLD."status" = 'SUBMITTED' AND NEW."status" = 'REJECTED')
    THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_REJECTION_REASON_WITH_REJECTION: a rejection''s reason is '
            'written once, in the move to REJECTED, and never revised.';
    END IF;

    IF OLD."status" = 'SUBMITTED' AND NEW."status" = 'REJECTED'
       AND (NEW."rejectionReason" IS NULL OR char_length(btrim(NEW."rejectionReason")) = 0)
    THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_REJECTION_NEEDS_REASON: a rejected version says why.';
    END IF;

    IF ROW(NEW."id", NEW."tenantId", NEW."profileId", NEW."version", NEW."instructionsHash",
           NEW."toolNames", NEW."skillRefs", NEW."modelTier", NEW."effort", NEW."maxTurns",
           NEW."outputKind", NEW."allowedTriggers", NEW."authoredByUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."profileId", OLD."version", OLD."instructionsHash",
           OLD."toolNames", OLD."skillRefs", OLD."modelTier", OLD."effort", OLD."maxTurns",
           OLD."outputKind", OLD."allowedTriggers", OLD."authoredByUserId", OLD."createdAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s settings never change; '
            'an edit is a new version, which starts at DRAFT.';
    END IF;

    IF (OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt")
       OR (OLD."submittedByUserId" IS NOT NULL AND NEW."submittedByUserId" IS DISTINCT FROM OLD."submittedByUserId")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (OLD."decidedByUserId" IS NOT NULL AND NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId")
       OR (OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt")
       OR (OLD."retiredByUserId" IS NOT NULL AND NEW."retiredByUserId" IS DISTINCT FROM OLD."retiredByUserId")
    THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_STAMP_WRITE_ONCE: a review stamp is recorded once and '
            'never revised.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'RETIRED'))
        OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'RETIRED'))
        OR (OLD."status" IN ('APPROVED', 'REJECTED') AND NEW."status" = 'RETIRED')
    ) THEN
        RAISE EXCEPTION
            'AGENT_PROFILE_STATUS_ONE_WAY: a version moves from % to % only one '
            'way; a decided version moves only to RETIRED, and RETIRED is terminal.',
            OLD."status", NEW."status";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. The ledger's label: which sub-agent a step was ──────────────
--
-- `WorkflowStep.subagentName` is set on every MODEL_CALL and TOOL_CALL a
-- sub-agent produces and NULL on every parent step. The CHECK holds it to the
-- name pattern (`^[a-z][a-z0-9_]{1,39}$`), so it reaches the hash-chained
-- audit row and the SIEM stream as an identifier. Added NOT VALID and then
-- validated in a second statement: every existing row is NULL, so validation
-- cannot fail, and the split is for the lock, because the step ledger grows
-- with every run and a plain ADD CONSTRAINT scans it under an exclusive lock.

ALTER TABLE "WorkflowStep" ADD COLUMN "subagentName" TEXT;

ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_subagent_name_shape"
    CHECK ("subagentName" IS NULL OR "subagentName" ~ '^[a-z][a-z0-9_]{1,39}$') NOT VALID;

ALTER TABLE "WorkflowStep" VALIDATE CONSTRAINT "WorkflowStep_subagent_name_shape";

-- ─── Rolling-deploy safety ──────────────────────────────────────────
--
-- Two nullable TEXT columns an older Prisma client never selects, and the
-- lifecycle function replaced in place. Every write the older image makes
-- leaves both columns NULL, so nothing it does is refused. An older image
-- cannot run a sub-agent version wrongly: it recomputes the content hash
-- without the sub-agents, gets a different value, and refuses.
