-- Phase 1 of docs/ai-architecture/langflow.md: THE FLOW INSIDE THE PROFILE VERSION.
--
-- A drawn flow becomes data on an `AgentProfileVersion`: `flowJson`, canonical
-- JSON of a checked flow (`src/lib/agentic/agent-flow.ts`), encrypted at rest
-- (Epic B) because its labels are the tenant's own words. NULL for every
-- version with no flow, which is every version that exists today.
--
-- Rules, held below the usecase:
--   * the column is frozen with the rest of the version, for every role
--     (trigger): an edit is a new version;
--   * the one change admitted after insert is the rotation sweeps' re-wrap,
--     ciphertext to `v2:` ciphertext with every other column unchanged, as for
--     `instructions` and `rejectionReason`;
--   * a stored flow is never the empty string (CHECK).
--
-- The content hash (`instructionsHash`) covers the flow when there is one;
-- that is computed in the writer and recomputed by the resolver, because the
-- column is ciphertext here.
--
-- ROLLING-DEPLOY SAFETY. One nullable column the previous image never reads,
-- one CHECK that every existing row (NULL) satisfies, and the lifecycle
-- function replaced in place. The previous image writes no `flowJson`, so its
-- inserts store NULL and its updates leave the column unchanged; nothing it
-- does is refused by the new function that the old one admitted.

ALTER TABLE "AgentProfileVersion" ADD COLUMN "flowJson" TEXT;

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_flow_json_present"
    CHECK ("flowJson" IS NULL OR char_length("flowJson") > 0);

-- The lifecycle function of 20261026150000_agent_profile_rejection_reason, with
-- `flowJson` added to the re-wrap exception and to the frozen settings. Every
-- rule it held is unchanged.
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
        OR NEW."flowJson" IS DISTINCT FROM OLD."flowJson")
       AND (to_jsonb(NEW) - 'instructions' - 'rejectionReason' - 'flowJson')
           = (to_jsonb(OLD) - 'instructions' - 'rejectionReason' - 'flowJson')
       AND (NEW."instructions" IS NOT DISTINCT FROM OLD."instructions"
            OR (OLD."instructions" ~ '^v[12]:' AND NEW."instructions" ~ '^v2:'))
       AND (NEW."rejectionReason" IS NOT DISTINCT FROM OLD."rejectionReason"
            OR (OLD."rejectionReason" ~ '^v[12]:' AND NEW."rejectionReason" ~ '^v2:'))
       AND (NEW."flowJson" IS NOT DISTINCT FROM OLD."flowJson"
            OR (OLD."flowJson" ~ '^v[12]:' AND NEW."flowJson" ~ '^v2:'))
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
