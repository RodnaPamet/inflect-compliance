-- Probe runs (active flavour, step 8a): the ingest of a prober's signed
-- report, `scanent-probes/1` — what a run of fixed attacker probes
-- (`scanent-probe`) made agents in an authorised engagement do. Verified by
-- the contract package against the tenant's trusted PROBER keys, and accepted
-- only when an approver key the tenant's owner registered signed the
-- engagement's scope (owner decisions, 2026-11-25):
--
--   AgentProberKey    a key a prober signs its reports with; the prober is a
--                     register row, and retiring it revokes the key
--   ProbeApproverKey  a key that may authorise an engagement; an owner's
--                     register, belonging to no agent
--   ProbeRun          one verified, ingested report
--   ProbeRunTarget    one target of a run; its endpoint ENCRYPTED (Epic B)
--   ProbeRunOutcome   one probe on one target; its excerpt ENCRYPTED
--
-- `usecases/agent-prober-keys.ts`, `usecases/probe-approver-keys.ts` and
-- `usecases/probe-runs.ts` are the only writers. Every table is
-- tenant-scoped and carries the canonical RLS triple. Nothing is backfilled:
-- there is nothing to backfill.

-- CreateTable
CREATE TABLE "AgentProberKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "AgentProberKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeApproverKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "ProbeApproverKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "proberAgentId" TEXT NOT NULL,
    "proberKeyId" TEXT NOT NULL,
    "approverKeyId" TEXT NOT NULL,
    "engagementId" TEXT NOT NULL,
    "scopeDigest" TEXT NOT NULL,
    "scopeSignerFingerprint" TEXT NOT NULL,
    "catalogueDigest" TEXT NOT NULL,
    "catalogueProbes" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "stopReason" TEXT,
    "surfaceDigest" TEXT NOT NULL,
    "concluded" BOOLEAN NOT NULL,
    "reportDigest" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL,
    "targetsReached" INTEGER NOT NULL,
    "outcomeCount" INTEGER NOT NULL,
    "actedCount" INTEGER NOT NULL,
    "disclosedCount" INTEGER NOT NULL,
    "resistedCount" INTEGER NOT NULL,
    "inconclusiveCount" INTEGER NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeRunTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "endpointDigest" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reached" BOOLEAN NOT NULL,
    "targetReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeRunTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProbeRunOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "probeId" TEXT NOT NULL,
    "probeClass" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "verdictReason" TEXT NOT NULL,
    "tool" TEXT,
    "replyDigest" TEXT,
    "excerpt" TEXT,
    "sourceRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProbeRunOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentProberKey_tenantId_agentId_idx" ON "AgentProberKey"("tenantId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProberKey_id_tenantId_key" ON "AgentProberKey"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentProberKey_tenantId_keyFingerprint_key" ON "AgentProberKey"("tenantId", "keyFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeApproverKey_id_tenantId_key" ON "ProbeApproverKey"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeApproverKey_tenantId_keyFingerprint_key" ON "ProbeApproverKey"("tenantId", "keyFingerprint");

-- CreateIndex
CREATE INDEX "ProbeRun_tenantId_startedAt_idx" ON "ProbeRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "ProbeRun_tenantId_proberAgentId_idx" ON "ProbeRun"("tenantId", "proberAgentId");

-- CreateIndex
CREATE INDEX "ProbeRun_tenantId_proberKeyId_idx" ON "ProbeRun"("tenantId", "proberKeyId");

-- CreateIndex
CREATE INDEX "ProbeRun_tenantId_approverKeyId_idx" ON "ProbeRun"("tenantId", "approverKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeRun_id_tenantId_key" ON "ProbeRun"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeRun_tenantId_reportDigest_key" ON "ProbeRun"("tenantId", "reportDigest");

-- CreateIndex
CREATE INDEX "ProbeRunTarget_tenantId_endpointDigest_idx" ON "ProbeRunTarget"("tenantId", "endpointDigest");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeRunTarget_id_tenantId_key" ON "ProbeRunTarget"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProbeRunTarget_tenantId_runId_endpointDigest_key" ON "ProbeRunTarget"("tenantId", "runId", "endpointDigest");

-- CreateIndex
CREATE INDEX "ProbeRunOutcome_tenantId_runId_idx" ON "ProbeRunOutcome"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "ProbeRunOutcome_tenantId_targetId_idx" ON "ProbeRunOutcome"("tenantId", "targetId");

-- CreateIndex
CREATE INDEX "ProbeRunOutcome_tenantId_sourceRef_idx" ON "ProbeRunOutcome"("tenantId", "sourceRef");

-- AddForeignKey
ALTER TABLE "AgentProberKey" ADD CONSTRAINT "AgentProberKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentProberKey" ADD CONSTRAINT "AgentProberKey_agentId_tenantId_fkey" FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeApproverKey" ADD CONSTRAINT "ProbeApproverKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRun" ADD CONSTRAINT "ProbeRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRun" ADD CONSTRAINT "ProbeRun_proberAgentId_tenantId_fkey" FOREIGN KEY ("proberAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRun" ADD CONSTRAINT "ProbeRun_proberKeyId_tenantId_fkey" FOREIGN KEY ("proberKeyId", "tenantId") REFERENCES "AgentProberKey"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRun" ADD CONSTRAINT "ProbeRun_approverKeyId_tenantId_fkey" FOREIGN KEY ("approverKeyId", "tenantId") REFERENCES "ProbeApproverKey"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRunTarget" ADD CONSTRAINT "ProbeRunTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRunTarget" ADD CONSTRAINT "ProbeRunTarget_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "ProbeRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRunOutcome" ADD CONSTRAINT "ProbeRunOutcome_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRunOutcome" ADD CONSTRAINT "ProbeRunOutcome_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "ProbeRun"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProbeRunOutcome" ADD CONSTRAINT "ProbeRunOutcome_targetId_tenantId_fkey" FOREIGN KEY ("targetId", "tenantId") REFERENCES "ProbeRunTarget"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on every table
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentProberKey" TO app_user;
ALTER TABLE "AgentProberKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentProberKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentProberKey";
CREATE POLICY tenant_isolation ON "AgentProberKey"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentProberKey";
CREATE POLICY tenant_isolation_insert ON "AgentProberKey"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentProberKey";
CREATE POLICY superuser_bypass ON "AgentProberKey"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProbeApproverKey" TO app_user;
ALTER TABLE "ProbeApproverKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProbeApproverKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProbeApproverKey";
CREATE POLICY tenant_isolation ON "ProbeApproverKey"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ProbeApproverKey";
CREATE POLICY tenant_isolation_insert ON "ProbeApproverKey"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProbeApproverKey";
CREATE POLICY superuser_bypass ON "ProbeApproverKey"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProbeRun" TO app_user;
ALTER TABLE "ProbeRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProbeRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProbeRun";
CREATE POLICY tenant_isolation ON "ProbeRun"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ProbeRun";
CREATE POLICY tenant_isolation_insert ON "ProbeRun"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProbeRun";
CREATE POLICY superuser_bypass ON "ProbeRun"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProbeRunTarget" TO app_user;
ALTER TABLE "ProbeRunTarget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProbeRunTarget" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProbeRunTarget";
CREATE POLICY tenant_isolation ON "ProbeRunTarget"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ProbeRunTarget";
CREATE POLICY tenant_isolation_insert ON "ProbeRunTarget"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProbeRunTarget";
CREATE POLICY superuser_bypass ON "ProbeRunTarget"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ProbeRunOutcome" TO app_user;
ALTER TABLE "ProbeRunOutcome" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProbeRunOutcome" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProbeRunOutcome";
CREATE POLICY tenant_isolation ON "ProbeRunOutcome"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ProbeRunOutcome";
CREATE POLICY tenant_isolation_insert ON "ProbeRunOutcome"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ProbeRunOutcome";
CREATE POLICY superuser_bypass ON "ProbeRunOutcome"
    USING (current_setting('role') != 'app_user');

-- ═══════════════════════════════════════════════════════════════════
-- A prober key is authority for its agent: nothing is minted for a retired
-- one. The shared function takes FOR SHARE on the agent row, so a key
-- inserted at the moment of retirement waits for it and is then refused
-- (`AGENT_RETIRED:`), as for every other authority-bearing table.
-- ═══════════════════════════════════════════════════════════════════

CREATE TRIGGER agent_prober_key_agent_not_retired
    BEFORE INSERT ON "AgentProberKey"
    FOR EACH ROW WHEN (NEW."revokedAt" IS NULL)
    EXECUTE FUNCTION agent_retired_refuses_authority();

-- ═══════════════════════════════════════════════════════════════════
-- The party that runs probes never authorises them (owner decision,
-- 2026-11-25; the contract's SIGNER_IS_PROBER): a key live in one register is
-- refused in the other. Both inserts take the same per-tenant advisory lock
-- before they look, so two concurrent registrations of one key, one in each
-- register, cannot both pass. VOLATILE: the read must see the other table as
-- it stands after the lock.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION probe_key_registers_disjoint() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
    clash boolean;
BEGIN
    IF NEW."revokedAt" IS NOT NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('probe-keys:' || NEW."tenantId"));
    IF TG_TABLE_NAME = 'AgentProberKey' THEN
        SELECT EXISTS (
            SELECT 1 FROM "ProbeApproverKey" k
             WHERE k."tenantId" = NEW."tenantId"
               AND k."keyFingerprint" = NEW."keyFingerprint"
               AND k."revokedAt" IS NULL
        ) INTO clash;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM "AgentProberKey" k
             WHERE k."tenantId" = NEW."tenantId"
               AND k."keyFingerprint" = NEW."keyFingerprint"
               AND k."revokedAt" IS NULL
        ) INTO clash;
    END IF;
    IF clash THEN
        RAISE EXCEPTION 'PROBE_KEY_IN_OTHER_REGISTER: this key is live in the other probe key register (%).', TG_TABLE_NAME;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER agent_prober_key_not_an_approver
    BEFORE INSERT ON "AgentProberKey"
    FOR EACH ROW EXECUTE FUNCTION probe_key_registers_disjoint();

CREATE TRIGGER probe_approver_key_not_a_prober
    BEFORE INSERT ON "ProbeApproverKey"
    FOR EACH ROW EXECUTE FUNCTION probe_key_registers_disjoint();
