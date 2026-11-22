-- #5530 (Step 2f, deploy 1 of 2) — DEFERRING A TOOL CALL TO A PERSON MID-RUN.
--
-- "Deferral to a person" in docs/claude-tool-runner-design.md is the design,
-- and its owner decisions of 2026-11-13 are this migration: a call to a
-- propose tool the profile version names WAITS for the proposal it queued to
-- be decided in the ordinary proposal queue (decision 1a); the run parks at
-- the existing AWAITING_APPROVAL, told apart by the row below (2a); the run
-- resumes from a transcript Inflect stores, encrypted, and clears it when it
-- resumes or settles, keeping its hash (3a).
--
-- ADDITIVE AND FORWARD-ONLY. No enum value is added, so the enum rule does not
-- bind, and nothing here changes what an existing row means. It still ships in
-- TWO deploys: this one carries the table, the column and every READER (the
-- refusals, the settlements and the resume branch), and nothing WRITES a
-- deferral yet, because the save and approval schemas still refuse
-- `deferredToolNames` and `RUNS_DEFERRALS` is false for every engine. Deploy 2
-- adds the writer. An older container meets a parked run only through code
-- this deploy taught it.

-- ─── 1. The table ───────────────────────────────────────────────────

CREATE TABLE "WorkflowRunDeferral" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepSeq" INTEGER NOT NULL,
    "toolUseId" TEXT NOT NULL,
    "toolCalled" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "decision" TEXT,
    "transcriptJson" TEXT,
    "transcriptHash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "elapsedMsAtPark" INTEGER NOT NULL,
    "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "resumedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "WorkflowRunDeferral_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkflowRunDeferral_tenantId_runId_idx" ON "WorkflowRunDeferral"("tenantId", "runId");

-- A proposal is waited for once: two deferrals naming one proposal would be
-- two runs continued by one decision.
CREATE UNIQUE INDEX "WorkflowRunDeferral_tenantId_proposalId_key" ON "WorkflowRunDeferral"("tenantId", "proposalId");

ALTER TABLE "WorkflowRunDeferral" ADD CONSTRAINT "WorkflowRunDeferral_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CASCADE from the run: a deferral of a run that no longer exists describes
-- nothing, and the transcript is the run's working state.
ALTER TABLE "WorkflowRunDeferral" ADD CONSTRAINT "WorkflowRunDeferral_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "WorkflowRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. The closed vocabularies, and the shape ──────────────────────
--
-- TEXT with CHECKs rather than Postgres enums: widening one is a CHECK change,
-- not an ALTER TYPE that fails still-running containers mid-deploy.
--
-- The shape ties each status to what it must carry: an open row (WAITING,
-- DECIDED) holds its transcript and a closed one (RESUMED, SETTLED) holds none
-- (owner decision 3: the transcript is cleared when the run resumes or
-- settles); a decision is a person's on DECIDED and RESUMED, and any on
-- SETTLED; each stamp is present exactly when its status was reached.
ALTER TABLE "WorkflowRunDeferral"
    ADD CONSTRAINT "WorkflowRunDeferral_shape"
    CHECK (
        "status" IN ('WAITING', 'DECIDED', 'RESUMED', 'SETTLED')
        AND ("decision" IS NULL OR "decision" IN ('ACCEPTED', 'EDITED', 'REJECTED', 'EXPIRED', 'NOT_RESUMED'))
        AND (("status" = 'WAITING') = ("decision" IS NULL))
        AND ("status" NOT IN ('DECIDED', 'RESUMED') OR "decision" IN ('ACCEPTED', 'EDITED', 'REJECTED'))
        AND (("status" IN ('RESUMED', 'SETTLED')) = ("transcriptJson" IS NULL))
        AND (("decidedAt" IS NOT NULL) = COALESCE("decision" IN ('ACCEPTED', 'EDITED', 'REJECTED'), false))
        AND (("decidedByUserId" IS NOT NULL) = ("decidedAt" IS NOT NULL))
        AND (("resumedAt" IS NOT NULL) = ("status" = 'RESUMED'))
        AND (("settledAt" IS NOT NULL) = ("status" = 'SETTLED'))
        AND "transcriptHash" ~ '^[0-9a-f]{64}$'
        AND "stepSeq" >= 0
        AND "elapsedMsAtPark" >= 0
        AND char_length("toolUseId") BETWEEN 1 AND 200
        AND char_length("toolCalled") BETWEEN 1 AND 200
        AND char_length("model") BETWEEN 1 AND 200
    );

-- ─── 3. One way, written once, and the transcript's two exceptions ──
--
-- Every column but the status, the decision, the stamps and the transcript is
-- frozen at insert. The status moves WAITING → DECIDED → RESUMED, or from
-- either open status to SETTLED, and never back. The decision and every stamp
-- are written once. The transcript changes in exactly two ways: to NULL (the
-- clear, which the shape CHECK pairs with RESUMED or SETTLED), or from
-- ciphertext to v2 ciphertext with every other column unchanged (the tenant-DEK
-- and master-KEK sweeps' raw re-wrap, which a write-once table with an
-- encrypted column must admit).
CREATE OR REPLACE FUNCTION workflow_run_deferral_one_way()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'WAITING' OR NEW."transcriptJson" IS NULL THEN
            RAISE EXCEPTION
                'WORKFLOW_RUN_DEFERRAL_STARTS_WAITING: a deferral is written once, WAITING, '
                'with its transcript.';
        END IF;
        RETURN NEW;
    END IF;

    -- The rotation sweeps' re-wrap: only the transcript changes, ciphertext to v2 ciphertext.
    IF NEW."transcriptJson" IS DISTINCT FROM OLD."transcriptJson"
       AND (to_jsonb(NEW) - 'transcriptJson') = (to_jsonb(OLD) - 'transcriptJson')
       AND OLD."transcriptJson" ~ '^v[12]:' AND NEW."transcriptJson" ~ '^v2:'
    THEN
        RETURN NEW;
    END IF;

    IF ROW(NEW."id", NEW."tenantId", NEW."runId", NEW."stepSeq", NEW."toolUseId", NEW."toolCalled",
           NEW."proposalId", NEW."transcriptHash", NEW."model", NEW."elapsedMsAtPark", NEW."parkedAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."runId", OLD."stepSeq", OLD."toolUseId", OLD."toolCalled",
           OLD."proposalId", OLD."transcriptHash", OLD."model", OLD."elapsedMsAtPark", OLD."parkedAt")
    THEN
        RAISE EXCEPTION
            'IMMUTABLE_WORKFLOW_RUN_DEFERRAL: a deferral''s call, proposal, hash, model and clock '
            'never change.';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
        (OLD."status" = 'WAITING' AND NEW."status" IN ('DECIDED', 'SETTLED'))
        OR (OLD."status" = 'DECIDED' AND NEW."status" IN ('RESUMED', 'SETTLED'))
    ) THEN
        RAISE EXCEPTION
            'WORKFLOW_RUN_DEFERRAL_ONE_WAY: a deferral moves from % to % only one way; '
            'RESUMED and SETTLED are terminal.',
            OLD."status", NEW."status";
    END IF;

    IF (OLD."decision" IS NOT NULL AND NEW."decision" IS DISTINCT FROM OLD."decision")
       OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
       OR (OLD."decidedByUserId" IS NOT NULL AND NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId")
       OR (OLD."resumedAt" IS NOT NULL AND NEW."resumedAt" IS DISTINCT FROM OLD."resumedAt")
       OR (OLD."settledAt" IS NOT NULL AND NEW."settledAt" IS DISTINCT FROM OLD."settledAt")
    THEN
        RAISE EXCEPTION
            'WORKFLOW_RUN_DEFERRAL_WRITE_ONCE: a deferral''s decision and stamps are recorded once '
            'and never revised.';
    END IF;

    IF NEW."transcriptJson" IS DISTINCT FROM OLD."transcriptJson" AND NEW."transcriptJson" IS NOT NULL THEN
        RAISE EXCEPTION
            'WORKFLOW_RUN_DEFERRAL_TRANSCRIPT_FROZEN: a transcript is never rewritten; it is only '
            'cleared, when the run resumes or settles.';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_deferral_one_way ON "WorkflowRunDeferral";
CREATE TRIGGER workflow_run_deferral_one_way
    BEFORE INSERT OR UPDATE ON "WorkflowRunDeferral"
    FOR EACH ROW EXECUTE FUNCTION workflow_run_deferral_one_way();

-- ─── 4. Grants and the RLS triple ───────────────────────────────────
--
-- No DELETE for `app_user`: a deferral goes with its run or its tenant, by
-- cascade, and nothing deletes one by hand.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "WorkflowRunDeferral" TO app_user;
        REVOKE DELETE ON "WorkflowRunDeferral" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "WorkflowRunDeferral" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowRunDeferral" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "WorkflowRunDeferral";
CREATE POLICY tenant_isolation ON "WorkflowRunDeferral"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "WorkflowRunDeferral";
CREATE POLICY tenant_isolation_insert ON "WorkflowRunDeferral"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "WorkflowRunDeferral";
CREATE POLICY superuser_bypass ON "WorkflowRunDeferral"
    USING (current_setting('role') != 'app_user');

-- ─── 5. The version's deferred tools ────────────────────────────────
--
-- A sorted, deduplicated subset of `toolNames`, each a propose tool, never
-- named by a sub-agent: the writer holds all four (deploy 2). The database
-- holds the subset, so a row naming a tool the version does not is refused
-- whoever writes it. Tool names are not secret: no encrypted-fields entry.

ALTER TABLE "AgentProfileVersion" ADD COLUMN "deferredToolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_deferred_tools_subset"
    CHECK ("deferredToolNames" <@ "toolNames");

-- ─── 6. The freeze, REPLACED IN THE SAME MIGRATION ──────────────────
--
-- The lifecycle function freezes the columns it lists, so a column it does not
-- list could be rewritten on an approved version: an approver would have
-- approved one set of waits and the run would make another. It is replaced
-- here with `deferredToolNames` added to the frozen settings. Every rule of
-- 20261113180000_agent_profile_compaction_threshold is unchanged.

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
           NEW."compactionThresholdTokens", NEW."deferredToolNames",
           NEW."outputKind", NEW."allowedTriggers", NEW."authoredByUserId", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."id", OLD."tenantId", OLD."profileId", OLD."version", OLD."instructionsHash",
           OLD."toolNames", OLD."skillRefs", OLD."modelTier", OLD."effort", OLD."maxTurns",
           OLD."compactionThresholdTokens", OLD."deferredToolNames",
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
-- A new table no older image reads, and a column with a default no older
-- image selects: every write an older image makes leaves it '{}', so nothing
-- it does is refused, and a version it saved defers nothing. Nothing writes a
-- deferral until deploy 2.
