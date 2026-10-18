-- Step 3a (#3674), deploy 2 of 2: agent recertification campaigns.
--
-- The AGENT value of "AccessReviewScope" shipped alone in
-- 20261018130000_access_review_agent_scope, and every container now reads it.
-- This migration adds what an AGENT campaign writes:
--
--   AccessReview                   + preparerAgentId, crossPreparerAgentId
--                                  (the two registered agents that prepare the packs)
--   AccessReviewConnectedDecision  + subjectAgentId, subjectOwnerUserId
--                                  (an agent subject, and its owner frozen)
--   AccessReviewAgentPack          one reviewer pack per agent subject
--   AccessReviewAgentNarrowing     one proposed grant deletion
--   AccessReviewDecisionSampleAudit one decision drawn for a second human
--
-- Forward-only and additive: nullable columns on two existing tables, a new
-- enum TYPE used only by a new table, three new tables. The previous image
-- reads none of the new columns or tables, so a rolling deploy is safe in both
-- directions. The one behavioural change to an EXISTING table is the one-way
-- trigger at the bottom, which refuses an UPDATE no code path makes.

-- CreateEnum
CREATE TYPE "AgentNarrowingOutcome" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "AccessReview" ADD COLUMN     "crossPreparerAgentId" TEXT,
ADD COLUMN     "preparerAgentId" TEXT;

-- AlterTable
ALTER TABLE "AccessReviewConnectedDecision" ADD COLUMN     "subjectAgentId" TEXT,
ADD COLUMN     "subjectOwnerUserId" TEXT;

-- CreateTable
CREATE TABLE "AccessReviewAgentPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accessReviewId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "preparedByRunId" TEXT NOT NULL,
    "preparedByAgentId" TEXT NOT NULL,
    "preparedByUserId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sectionsJson" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "AccessReviewAgentPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReviewAgentNarrowing" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accessReviewId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "basis" TEXT NOT NULL,
    "subjectOwnerUserId" TEXT NOT NULL,
    "outcome" "AgentNarrowingOutcome" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executionResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "AccessReviewAgentNarrowing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReviewDecisionSampleAudit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accessReviewId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "samplingEpoch" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToUserId" TEXT,
    "outcome" "AgentSampleAuditOutcome" NOT NULL DEFAULT 'PENDING',
    "dissentCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "AccessReviewDecisionSampleAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessReviewAgentPack_tenantId_accessReviewId_idx" ON "AccessReviewAgentPack"("tenantId", "accessReviewId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewAgentPack_decisionId_tenantId_key" ON "AccessReviewAgentPack"("decisionId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewAgentPack_id_tenantId_key" ON "AccessReviewAgentPack"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AccessReviewAgentNarrowing_tenantId_accessReviewId_outcome_idx" ON "AccessReviewAgentNarrowing"("tenantId", "accessReviewId", "outcome");

-- CreateIndex
CREATE INDEX "AccessReviewAgentNarrowing_tenantId_decisionId_idx" ON "AccessReviewAgentNarrowing"("tenantId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewAgentNarrowing_packId_grantId_key" ON "AccessReviewAgentNarrowing"("packId", "grantId");

-- CreateIndex
CREATE INDEX "AccessReviewDecisionSampleAudit_tenantId_accessReviewId_idx" ON "AccessReviewDecisionSampleAudit"("tenantId", "accessReviewId");

-- CreateIndex
CREATE INDEX "AccessReviewDecisionSampleAudit_tenantId_outcome_sampledAt_idx" ON "AccessReviewDecisionSampleAudit"("tenantId", "outcome", "sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewDecisionSampleAudit_tenantId_decisionId_key" ON "AccessReviewDecisionSampleAudit"("tenantId", "decisionId");

-- CreateIndex
CREATE INDEX "AccessReviewConnectedDecision_tenantId_subjectAgentId_idx" ON "AccessReviewConnectedDecision"("tenantId", "subjectAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewConnectedDecision_id_tenantId_key" ON "AccessReviewConnectedDecision"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "AccessReviewAgentPack" ADD CONSTRAINT "AccessReviewAgentPack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentPack" ADD CONSTRAINT "AccessReviewAgentPack_accessReviewId_tenantId_fkey" FOREIGN KEY ("accessReviewId", "tenantId") REFERENCES "AccessReview"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentPack" ADD CONSTRAINT "AccessReviewAgentPack_decisionId_tenantId_fkey" FOREIGN KEY ("decisionId", "tenantId") REFERENCES "AccessReviewConnectedDecision"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_accessReviewId_tenantId_fkey" FOREIGN KEY ("accessReviewId", "tenantId") REFERENCES "AccessReview"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_decisionId_tenantId_fkey" FOREIGN KEY ("decisionId", "tenantId") REFERENCES "AccessReviewConnectedDecision"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_packId_tenantId_fkey" FOREIGN KEY ("packId", "tenantId") REFERENCES "AccessReviewAgentPack"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewDecisionSampleAudit" ADD CONSTRAINT "AccessReviewDecisionSampleAudit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewDecisionSampleAudit" ADD CONSTRAINT "AccessReviewDecisionSampleAudit_accessReviewId_tenantId_fkey" FOREIGN KEY ("accessReviewId", "tenantId") REFERENCES "AccessReview"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewDecisionSampleAudit" ADD CONSTRAINT "AccessReviewDecisionSampleAudit_decisionId_tenantId_fkey" FOREIGN KEY ("decisionId", "tenantId") REFERENCES "AccessReviewConnectedDecision"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── The owner may not decide their own agent ───────────────────────────
--
-- Held by the database as well as the usecase. A CHECK can compare two columns
-- of one row, so the frozen owner rides on every row it constrains rather than
-- being joined from "RegisteredAgent", whose owner can move by transfer. The
-- usecase ALSO refuses the agent's CURRENT owner; this is the half that holds
-- for any writer.
ALTER TABLE "AccessReviewConnectedDecision" ADD CONSTRAINT "AccessReviewConnectedDecision_owner_not_decider"
    CHECK ("subjectOwnerUserId" IS NULL OR "decidedByUserId" IS NULL OR "decidedByUserId" <> "subjectOwnerUserId");

ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_owner_not_decider"
    CHECK ("decidedByUserId" IS NULL OR "decidedByUserId" <> "subjectOwnerUserId");

-- An AGENT campaign names two DIFFERENT preparing agents; no other scope names
-- any. Roadmap rule 8 — the auditor is not the auditee — is why there are two:
-- every agent that can prepare a pack is ACTIVE, so it is always in the frozen
-- population, and its own pack must come from somebody else.
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_agent_preparers"
    CHECK (
        ("scope" = 'AGENT'
            AND "preparerAgentId" IS NOT NULL
            AND "crossPreparerAgentId" IS NOT NULL
            AND "preparerAgentId" <> "crossPreparerAgentId")
        OR ("scope" <> 'AGENT' AND "preparerAgentId" IS NULL AND "crossPreparerAgentId" IS NULL)
    );

-- Rule 8 again, on the pack itself, for any writer: no agent prepares the pack
-- it is reviewed by.
ALTER TABLE "AccessReviewAgentPack" ADD CONSTRAINT "AccessReviewAgentPack_not_self_prepared"
    CHECK ("preparedByAgentId" <> "agentId");

-- A narrowing's stamp is all-or-nothing, and only an ACCEPTED one executes.
ALTER TABLE "AccessReviewAgentNarrowing" ADD CONSTRAINT "AccessReviewAgentNarrowing_stamp_consistent"
    CHECK (
        (("outcome" = 'PENDING') = ("decidedAt" IS NULL))
        AND (("decidedAt" IS NULL) = ("decidedByUserId" IS NULL))
        AND (("executedAt" IS NULL) = ("executionResult" IS NULL))
        AND ("executedAt" IS NULL OR "outcome" = 'ACCEPTED')
        AND ("executionResult" IS NULL OR "executionResult" IN ('GRANT_DELETED', 'GRANT_ALREADY_ABSENT'))
    );

ALTER TABLE "AccessReviewDecisionSampleAudit" ADD CONSTRAINT "AccessReviewDecisionSampleAudit_stamp_consistent"
    CHECK (
        (("outcome" = 'PENDING') = ("reviewedAt" IS NULL))
        AND (("reviewedAt" IS NULL) = ("reviewedByUserId" IS NULL))
    );

-- ─── Decisions are one-way stamps ────────────────────────────────────────
--
-- Every scope's connected decision, not only an agent's. The application
-- already treats them so — `submitConnectedDecision` writes only where
-- `decision IS NULL`, and nothing resets one — and a recertification verdict
-- that can be rewritten after the fact is a claim about the past the present
-- can edit. The subject is frozen too: the row is the record of what the
-- reviewer saw. `connectedAccountId` may still go to NULL (its FK is SET NULL
-- when a directory account is deleted); nothing else that identifies the
-- subject may move.
CREATE OR REPLACE FUNCTION access_review_connected_decision_one_way() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."accessReviewId" IS DISTINCT FROM OLD."accessReviewId"
        OR NEW."subjectRef" IS DISTINCT FROM OLD."subjectRef"
        OR NEW."snapshotJson"::jsonb IS DISTINCT FROM OLD."snapshotJson"::jsonb
        OR NEW."subjectAgentId" IS DISTINCT FROM OLD."subjectAgentId"
        OR NEW."subjectOwnerUserId" IS DISTINCT FROM OLD."subjectOwnerUserId"
        OR (NEW."connectedAccountId" IS DISTINCT FROM OLD."connectedAccountId" AND NEW."connectedAccountId" IS NOT NULL)
    THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_SUBJECT_FROZEN: a campaign subject is frozen when the campaign is created'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."decision" IS NOT NULL AND (
        NEW."decision" IS DISTINCT FROM OLD."decision"
        OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
        OR NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId"
        OR NEW."notes" IS DISTINCT FROM OLD."notes"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_DECISION_STAMPED: a recorded decision cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."executedAt" IS NOT NULL AND (
        NEW."executedAt" IS DISTINCT FROM OLD."executedAt"
        OR NEW."executedByUserId" IS DISTINCT FROM OLD."executedByUserId"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_DECISION_STAMPED: an executed decision cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_connected_decision_one_way ON "AccessReviewConnectedDecision";
CREATE TRIGGER access_review_connected_decision_one_way
    BEFORE UPDATE ON "AccessReviewConnectedDecision"
    FOR EACH ROW EXECUTE FUNCTION access_review_connected_decision_one_way();

-- A pack is written once and never edited.
CREATE OR REPLACE FUNCTION access_review_agent_pack_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'ACCESS_REVIEW_PACK_IMMUTABLE: a reviewer pack is never edited after it is written'
        USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_agent_pack_immutable ON "AccessReviewAgentPack";
CREATE TRIGGER access_review_agent_pack_immutable
    BEFORE UPDATE ON "AccessReviewAgentPack"
    FOR EACH ROW EXECUTE FUNCTION access_review_agent_pack_immutable();

-- A narrowing: the proposal is frozen, the outcome leaves PENDING once, the
-- grant delete is stamped once.
CREATE OR REPLACE FUNCTION access_review_agent_narrowing_one_way() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."accessReviewId" IS DISTINCT FROM OLD."accessReviewId"
        OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId"
        OR NEW."packId" IS DISTINCT FROM OLD."packId"
        OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
        OR NEW."grantId" IS DISTINCT FROM OLD."grantId"
        OR NEW."toolName" IS DISTINCT FROM OLD."toolName"
        OR NEW."grantedByUserId" IS DISTINCT FROM OLD."grantedByUserId"
        OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
        OR NEW."basis" IS DISTINCT FROM OLD."basis"
        OR NEW."subjectOwnerUserId" IS DISTINCT FROM OLD."subjectOwnerUserId"
    THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_NARROWING_FROZEN: a proposed narrowing is never edited'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."outcome" <> 'PENDING' AND (
        NEW."outcome" IS DISTINCT FROM OLD."outcome"
        OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
        OR NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_NARROWING_STAMPED: a decided narrowing cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."executedAt" IS NOT NULL AND (
        NEW."executedAt" IS DISTINCT FROM OLD."executedAt"
        OR NEW."executionResult" IS DISTINCT FROM OLD."executionResult"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_NARROWING_STAMPED: an executed narrowing cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_agent_narrowing_one_way ON "AccessReviewAgentNarrowing";
CREATE TRIGGER access_review_agent_narrowing_one_way
    BEFORE UPDATE ON "AccessReviewAgentNarrowing"
    FOR EACH ROW EXECUTE FUNCTION access_review_agent_narrowing_one_way();

-- A sample: drawn once, answered once.
CREATE OR REPLACE FUNCTION access_review_decision_sample_one_way() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."accessReviewId" IS DISTINCT FROM OLD."accessReviewId"
        OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId"
        OR NEW."samplingEpoch" IS DISTINCT FROM OLD."samplingEpoch"
        OR NEW."sampledAt" IS DISTINCT FROM OLD."sampledAt"
        OR NEW."assignedToUserId" IS DISTINCT FROM OLD."assignedToUserId"
    THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_SAMPLE_FROZEN: a drawn sample is never re-drawn'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."outcome" <> 'PENDING' AND (
        NEW."outcome" IS DISTINCT FROM OLD."outcome"
        OR NEW."dissentCodes" IS DISTINCT FROM OLD."dissentCodes"
        OR NEW."reviewedAt" IS DISTINCT FROM OLD."reviewedAt"
        OR NEW."reviewedByUserId" IS DISTINCT FROM OLD."reviewedByUserId"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_SAMPLE_STAMPED: an answered sample cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_decision_sample_one_way ON "AccessReviewDecisionSampleAudit";
CREATE TRIGGER access_review_decision_sample_one_way
    BEFORE UPDATE ON "AccessReviewDecisionSampleAudit"
    FOR EACH ROW EXECUTE FUNCTION access_review_decision_sample_one_way();

-- ─── Privileges and row-level security ──────────────────────────────────
--
-- `app_user` reads, inserts and (for the stamps) updates; it never deletes.
-- These are regulatory artefacts, kept with their campaign: a tenant purge
-- runs privileged, and a referential CASCADE runs as the table owner. Default
-- privileges grant DELETE to `app_user` (20260323180000), so it is revoked
-- explicitly. A pack is never updated either, so it gets no UPDATE.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT ON "AccessReviewAgentPack" TO app_user;
        REVOKE UPDATE, DELETE ON "AccessReviewAgentPack" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "AccessReviewAgentNarrowing" TO app_user;
        REVOKE DELETE ON "AccessReviewAgentNarrowing" FROM app_user;
        GRANT SELECT, INSERT, UPDATE ON "AccessReviewDecisionSampleAudit" TO app_user;
        REVOKE DELETE ON "AccessReviewDecisionSampleAudit" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AccessReviewAgentPack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewAgentPack" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AccessReviewAgentPack";
CREATE POLICY tenant_isolation ON "AccessReviewAgentPack"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AccessReviewAgentPack";
CREATE POLICY tenant_isolation_insert ON "AccessReviewAgentPack"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AccessReviewAgentPack";
CREATE POLICY superuser_bypass ON "AccessReviewAgentPack"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AccessReviewAgentNarrowing" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewAgentNarrowing" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AccessReviewAgentNarrowing";
CREATE POLICY tenant_isolation ON "AccessReviewAgentNarrowing"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AccessReviewAgentNarrowing";
CREATE POLICY tenant_isolation_insert ON "AccessReviewAgentNarrowing"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AccessReviewAgentNarrowing";
CREATE POLICY superuser_bypass ON "AccessReviewAgentNarrowing"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "AccessReviewDecisionSampleAudit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewDecisionSampleAudit" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AccessReviewDecisionSampleAudit";
CREATE POLICY tenant_isolation ON "AccessReviewDecisionSampleAudit"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AccessReviewDecisionSampleAudit";
CREATE POLICY tenant_isolation_insert ON "AccessReviewDecisionSampleAudit"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AccessReviewDecisionSampleAudit";
CREATE POLICY superuser_bypass ON "AccessReviewDecisionSampleAudit"
    USING (current_setting('role') != 'app_user');
