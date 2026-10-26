-- Step 1b of docs/claude-agent-sdk-design.md (#4144): a rejection carries its reason.
--
-- The builder's Reject asks the reviewer why, and the author reads the answer
-- on the version they wrote. Step 1a recorded who decided and when; this adds
-- the why, as an encrypted column (Epic B), because a reviewer's sentence about
-- an agent's instructions is business content like the instructions themselves.
--
-- Rules, held below the usecase:
--   * the reason is written in the move from SUBMITTED to REJECTED, and only
--     then (trigger);
--   * a move to REJECTED carries one (trigger, so no existing row is
--     re-validated);
--   * it is never revised, and the one change admitted afterwards is the
--     rotation sweeps' re-wrap: ciphertext to `v2:` ciphertext with every
--     other column unchanged, as for `instructions`.
--
-- ROLLING-DEPLOY SAFETY. One nullable column the previous image never reads,
-- and a function replaced in place. The previous image's reject writes no
-- reason, so its move to REJECTED would now be refused by the trigger; the
-- surface is behind AGENT_PROFILES, which is off in every deployment, so no
-- such write exists to break.

ALTER TABLE "AgentProfileVersion" ADD COLUMN "rejectionReason" TEXT;

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_rejection_reason_with_decision"
    CHECK ("rejectionReason" IS NULL OR "decidedAt" IS NOT NULL);

-- The lifecycle function of 20261026100000_agent_profiles, with the reason
-- added. Every rule it held is unchanged.
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
        OR NEW."rejectionReason" IS DISTINCT FROM OLD."rejectionReason")
       AND (to_jsonb(NEW) - 'instructions' - 'rejectionReason') = (to_jsonb(OLD) - 'instructions' - 'rejectionReason')
       AND (NEW."instructions" IS NOT DISTINCT FROM OLD."instructions"
            OR (OLD."instructions" ~ '^v[12]:' AND NEW."instructions" ~ '^v2:'))
       AND (NEW."rejectionReason" IS NOT DISTINCT FROM OLD."rejectionReason"
            OR (OLD."rejectionReason" ~ '^v[12]:' AND NEW."rejectionReason" ~ '^v2:'))
    THEN
        RETURN NEW;
    END IF;

    IF NEW."instructions" IS DISTINCT FROM OLD."instructions" THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_PROFILE_VERSION: a version''s instructions never change; '
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
