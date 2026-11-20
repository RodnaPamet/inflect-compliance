-- Agent Pay Phase 1.4 (#5333; owner decisions of 2026-11-20): an AGENT
-- campaign's pack may propose WITHDRAWING an agent's declared spending
-- envelope, never reducing it.
--
--   AccessReviewAgentSpendingWithdrawal  one proposed withdrawal, its grounds,
--                                        the person's ACCEPT/REJECT, and what
--                                        accepting it did
--
-- Forward-only and additive: one new table, using two enum TYPES that already
-- exist (no new enum value, so no two-deploy split is needed). The previous
-- image reads and writes nothing here, so a rolling deploy is safe in both
-- directions. `AccessReviewAgentNarrowing` is not touched.

-- CreateTable
CREATE TABLE "AccessReviewAgentSpendingWithdrawal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accessReviewId" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "rail" "AgentSpendingRail" NOT NULL,
    "declaredAt" TIMESTAMP(3) NOT NULL,
    "statusAtPack" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grounds" TEXT[],
    "subjectOwnerUserId" TEXT NOT NULL,
    "outcome" "AgentNarrowingOutcome" NOT NULL DEFAULT 'PENDING',
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "executedAt" TIMESTAMP(3),
    "executionResult" TEXT,
    "ownerTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessReviewAgentSpendingWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessReviewAgentSpendingWithdrawal_tenantId_accessReviewId_idx" ON "AccessReviewAgentSpendingWithdrawal"("tenantId", "accessReviewId", "outcome");

-- CreateIndex
CREATE INDEX "AccessReviewAgentSpendingWithdrawal_tenantId_decisionId_idx" ON "AccessReviewAgentSpendingWithdrawal"("tenantId", "decisionId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewAgentSpendingWithdrawal_packId_rail_key" ON "AccessReviewAgentSpendingWithdrawal"("packId", "rail");

-- AddForeignKey
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_accessReviewId_tenantI_fkey" FOREIGN KEY ("accessReviewId", "tenantId") REFERENCES "AccessReview"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_decisionId_tenantId_fkey" FOREIGN KEY ("decisionId", "tenantId") REFERENCES "AccessReviewConnectedDecision"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_packId_tenantId_fkey" FOREIGN KEY ("packId", "tenantId") REFERENCES "AccessReviewAgentPack"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── The owner may not decide their own agent ───────────────────────────
-- As on the narrowing: the frozen owner rides on the row so a CHECK can hold
-- it for any writer; the usecase also refuses the CURRENT owner.
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_owner_not_decider"
    CHECK ("decidedByUserId" IS NULL OR "decidedByUserId" <> "subjectOwnerUserId");

-- At least one ground, each from the vocabulary (`SPENDING_WITHDRAWAL_GROUNDS`).
-- A new ground widens this CHECK in a migration of its own; never repurpose one.
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_grounds"
    CHECK (
        "grounds" IS NOT NULL
        AND cardinality("grounds") >= 1
        AND "grounds" <@ ARRAY['EXPIRED_BY_WINDOW_END', 'SUSPENDED_AFTER_KILL', 'NEVER_REVIEWED']::TEXT[]
    );

-- The stamp is all-or-nothing; only an ACCEPTED withdrawal executes; a task is
-- opened only when the envelope ends withdrawn.
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ADD CONSTRAINT "AccessReviewAgentSpendingWithdrawal_stamp_consistent"
    CHECK (
        (("outcome" = 'PENDING') = ("decidedAt" IS NULL))
        AND (("decidedAt" IS NULL) = ("decidedByUserId" IS NULL))
        AND (("executedAt" IS NULL) = ("executionResult" IS NULL))
        AND ("executedAt" IS NULL OR "outcome" = 'ACCEPTED')
        AND ("executionResult" IS NULL OR "executionResult" IN (
            'ENVELOPE_WITHDRAWN', 'ENVELOPE_ALREADY_WITHDRAWN', 'ENVELOPE_REDECLARED', 'ENVELOPE_ABSENT'))
        AND ("ownerTaskId" IS NULL OR "executionResult" IN ('ENVELOPE_WITHDRAWN', 'ENVELOPE_ALREADY_WITHDRAWN'))
    );

-- ─── One-way stamps ──────────────────────────────────────────────────────
-- The proposal is frozen, the outcome leaves PENDING once, the execution (and
-- the owner's task) is stamped once.
CREATE OR REPLACE FUNCTION access_review_agent_spending_withdrawal_one_way() RETURNS trigger AS $$
BEGIN
    IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
        OR NEW."accessReviewId" IS DISTINCT FROM OLD."accessReviewId"
        OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId"
        OR NEW."packId" IS DISTINCT FROM OLD."packId"
        OR NEW."agentId" IS DISTINCT FROM OLD."agentId"
        OR NEW."rail" IS DISTINCT FROM OLD."rail"
        OR NEW."declaredAt" IS DISTINCT FROM OLD."declaredAt"
        OR NEW."statusAtPack" IS DISTINCT FROM OLD."statusAtPack"
        OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
        OR NEW."grounds" IS DISTINCT FROM OLD."grounds"
        OR NEW."subjectOwnerUserId" IS DISTINCT FROM OLD."subjectOwnerUserId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_WITHDRAWAL_FROZEN: a proposed withdrawal is never edited'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."outcome" <> 'PENDING' AND (
        NEW."outcome" IS DISTINCT FROM OLD."outcome"
        OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
        OR NEW."decidedByUserId" IS DISTINCT FROM OLD."decidedByUserId"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_WITHDRAWAL_STAMPED: a decided withdrawal cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    IF OLD."executedAt" IS NOT NULL AND (
        NEW."executedAt" IS DISTINCT FROM OLD."executedAt"
        OR NEW."executionResult" IS DISTINCT FROM OLD."executionResult"
        OR NEW."ownerTaskId" IS DISTINCT FROM OLD."ownerTaskId"
    ) THEN
        RAISE EXCEPTION 'ACCESS_REVIEW_WITHDRAWAL_STAMPED: an executed withdrawal cannot be changed'
            USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_review_agent_spending_withdrawal_one_way ON "AccessReviewAgentSpendingWithdrawal";
CREATE TRIGGER access_review_agent_spending_withdrawal_one_way
    BEFORE UPDATE ON "AccessReviewAgentSpendingWithdrawal"
    FOR EACH ROW EXECUTE FUNCTION access_review_agent_spending_withdrawal_one_way();

-- ─── Privileges and row-level security ──────────────────────────────────
-- A regulatory artefact, kept with its campaign: `app_user` reads, inserts and
-- updates (for the stamps), never deletes. Default privileges grant DELETE to
-- `app_user` (20260323180000), so it is revoked explicitly.
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_user') THEN
        GRANT SELECT, INSERT, UPDATE ON "AccessReviewAgentSpendingWithdrawal" TO app_user;
        REVOKE DELETE ON "AccessReviewAgentSpendingWithdrawal" FROM app_user;
    END IF;
END
$$;

ALTER TABLE "AccessReviewAgentSpendingWithdrawal" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccessReviewAgentSpendingWithdrawal" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AccessReviewAgentSpendingWithdrawal";
CREATE POLICY tenant_isolation ON "AccessReviewAgentSpendingWithdrawal"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AccessReviewAgentSpendingWithdrawal";
CREATE POLICY tenant_isolation_insert ON "AccessReviewAgentSpendingWithdrawal"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AccessReviewAgentSpendingWithdrawal";
CREATE POLICY superuser_bypass ON "AccessReviewAgentSpendingWithdrawal"
    USING (current_setting('role') != 'app_user');
