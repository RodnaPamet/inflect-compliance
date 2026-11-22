-- #5531 (Step 2g) — A PROFILE VERSION'S CONTEXT-COMPACTION THRESHOLD.
--
-- "Compaction" in docs/claude-tool-runner-design.md is the design, and its
-- owner decision 2 of 2026-11-13 is this column: a version may turn the
-- engine's compaction off, or lower its threshold, and never raise it. It is
-- a setting of the version, so it inherits the version's lifecycle and its
-- four-eyes approval; the approval view shows it.
--
-- ─── 1. The column: a number, bounded ───────────────────────────────
--
-- NULL takes the engine's threshold (every version that exists today), 0
-- turns compaction off, and any other value is 10,000 to 150,000 tokens:
-- `PROFILE_COMPACTION_THRESHOLD_MIN` / `_MAX` in src/lib/agentic/agent-profile.ts.
-- The writer also refuses a value above the TIER's engine threshold
-- (`COMPACTION_THRESHOLD_ABOVE_TIER`); 150,000 is both tiers' today. A number
-- carries no tenant text, so there is no encrypted-fields manifest entry.

ALTER TABLE "AgentProfileVersion" ADD COLUMN "compactionThresholdTokens" INTEGER;

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_compaction_threshold_bounded"
    CHECK (
        "compactionThresholdTokens" IS NULL
        OR "compactionThresholdTokens" = 0
        OR "compactionThresholdTokens" BETWEEN 10000 AND 150000
    );

-- ─── 2. The freeze, REPLACED IN THE SAME MIGRATION ──────────────────
--
-- The lifecycle function freezes the columns it lists, so a column it does not
-- list could be rewritten on an approved version: an approver would have
-- approved one threshold and the run would use another. It is replaced here
-- with `compactionThresholdTokens` added to the frozen settings. Every rule of
-- 20261113150000_agent_profile_subagents is unchanged. The column is not
-- encrypted, so the rotation sweeps' re-wrap exception does not name it: its
-- `to_jsonb(NEW) - … = to_jsonb(OLD) - …` comparison already requires it to be
-- unchanged.

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
           NEW."compactionThresholdTokens",
           NEW."outputKind", NEW."allowedTriggers", NEW."authoredByUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."profileId", OLD."version", OLD."instructionsHash",
           OLD."toolNames", OLD."skillRefs", OLD."modelTier", OLD."effort", OLD."maxTurns",
           OLD."compactionThresholdTokens",
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

-- ─── Rolling-deploy safety ──────────────────────────────────────────
--
-- ONE DEPLOY. A nullable INTEGER an older Prisma client never selects, and the
-- lifecycle function replaced in place. Every write an older image makes leaves
-- the column NULL, so nothing it does is refused. The column is NOT in the
-- content hash, so an older worker running a version that sets it resolves the
-- version, does not compact, and behaves exactly as it does today.
