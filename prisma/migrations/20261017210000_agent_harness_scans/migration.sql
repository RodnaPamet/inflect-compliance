-- Step 1a of the agentic IAM roadmap (#3665) — harness assurance.
--
-- A scanner in the client's environment returns a signed
-- `inflect-agent-harness/1` report (docs/agent-harness-contract.md). These five
-- tables hold what Inflect makes of one:
--
--   AgentHarnessScannerKey  the public keys a tenant trusts to sign reports;
--                           each belongs to the registered agent that is the
--                           scanner
--   AgentHarnessScan        one verified, ingested report
--   DiscoveredAgent         an agent-shaped principal some scan found
--   AgentHarnessScanItem    one agent in one scan, with its DERIVED level
--   AgentHarnessAcceptance  a time-limited acceptance of one agent's shortfall
--
-- Identifiers, references, hashes and counts only. The one free-text column,
-- AgentHarnessAcceptance.justification, is written by a person and is in the
-- encryption manifest.
--
-- All five are tenant-scoped and carry the canonical RLS triple. Nothing is
-- backfilled: there is nothing to backfill.

-- CreateEnum
CREATE TYPE "AgentHarnessLevel" AS ENUM ('H0', 'H1', 'H2', 'H3', 'H4', 'H5');

-- CreateEnum
CREATE TYPE "AgentHarnessReach" AS ENUM ('READ_ONLY', 'WRITE_OR_EXTERNAL', 'UNKNOWN');

-- CreateTable
CREATE TABLE "AgentHarnessScannerKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,

    CONSTRAINT "AgentHarnessScannerKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHarnessScan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scanRef" TEXT NOT NULL,
    "scannerAgentId" TEXT NOT NULL,
    "scannerKeyId" TEXT NOT NULL,
    "scannerVersion" TEXT NOT NULL,
    "scannerManifestHash" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "reportDigest" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "sourcesJson" JSONB NOT NULL,
    "agentCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentHarnessScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "discoveredId" TEXT NOT NULL,
    "discoveredVia" TEXT[],
    "registeredAgentId" TEXT,
    "ownerKind" TEXT,
    "ownerRef" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastScanId" TEXT NOT NULL,
    "lastLevel" "AgentHarnessLevel" NOT NULL,
    "lastReach" "AgentHarnessReach" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHarnessScanItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "discoveredAgentId" TEXT NOT NULL,
    "level" "AgentHarnessLevel" NOT NULL,
    "reach" "AgentHarnessReach" NOT NULL,
    "verdictsJson" JSONB NOT NULL,
    "blockingNextRung" TEXT[],
    "toolsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentHarnessScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHarnessAcceptance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "discoveredAgentId" TEXT NOT NULL,
    "acceptedLevel" "AgentHarnessLevel" NOT NULL,
    "justification" TEXT NOT NULL,
    "acceptedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewedFromId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "expiryProcessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentHarnessAcceptance_pkey" PRIMARY KEY ("id")
);

-- An acceptance with no future is not an acceptance. ControlException CHECKs
-- its expiry once APPROVED; this row is approved by existing, so always.
ALTER TABLE "AgentHarnessAcceptance"
    ADD CONSTRAINT "AgentHarnessAcceptance_expires_after_creation"
    CHECK ("expiresAt" > "createdAt");

-- The owner vocabulary the contract defines, pinned so a third value cannot
-- appear silently.
ALTER TABLE "DiscoveredAgent"
    ADD CONSTRAINT "DiscoveredAgent_owner_kind_known"
    CHECK ("ownerKind" IS NULL OR "ownerKind" IN ('user', 'group'));
ALTER TABLE "DiscoveredAgent"
    ADD CONSTRAINT "DiscoveredAgent_owner_pair"
    CHECK (("ownerKind" IS NULL) = ("ownerRef" IS NULL));

-- A count cannot be negative, and an empty scan is a row like any other — it
-- is the ingest that refuses to read one as clean, not the table.
ALTER TABLE "AgentHarnessScan"
    ADD CONSTRAINT "AgentHarnessScan_agent_count_non_negative"
    CHECK ("agentCount" >= 0);

-- CreateIndex
CREATE INDEX "AgentHarnessScannerKey_tenantId_agentId_idx" ON "AgentHarnessScannerKey"("tenantId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessScannerKey_id_tenantId_key" ON "AgentHarnessScannerKey"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessScannerKey_tenantId_keyFingerprint_key" ON "AgentHarnessScannerKey"("tenantId", "keyFingerprint");

-- CreateIndex
CREATE INDEX "AgentHarnessScan_tenantId_asOf_idx" ON "AgentHarnessScan"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "AgentHarnessScan_tenantId_scannerAgentId_idx" ON "AgentHarnessScan"("tenantId", "scannerAgentId");

-- CreateIndex
CREATE INDEX "AgentHarnessScan_tenantId_scannerKeyId_idx" ON "AgentHarnessScan"("tenantId", "scannerKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessScan_id_tenantId_key" ON "AgentHarnessScan"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessScan_tenantId_scanRef_key" ON "AgentHarnessScan"("tenantId", "scanRef");

-- CreateIndex
CREATE INDEX "DiscoveredAgent_tenantId_registeredAgentId_idx" ON "DiscoveredAgent"("tenantId", "registeredAgentId");

-- CreateIndex
CREATE INDEX "DiscoveredAgent_tenantId_lastSeenAt_idx" ON "DiscoveredAgent"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredAgent_id_tenantId_key" ON "DiscoveredAgent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredAgent_tenantId_discoveredId_key" ON "DiscoveredAgent"("tenantId", "discoveredId");

-- CreateIndex
CREATE INDEX "AgentHarnessScanItem_tenantId_discoveredAgentId_idx" ON "AgentHarnessScanItem"("tenantId", "discoveredAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessScanItem_tenantId_scanId_discoveredAgentId_key" ON "AgentHarnessScanItem"("tenantId", "scanId", "discoveredAgentId");

-- CreateIndex
CREATE INDEX "AgentHarnessAcceptance_tenantId_discoveredAgentId_idx" ON "AgentHarnessAcceptance"("tenantId", "discoveredAgentId");

-- CreateIndex
CREATE INDEX "AgentHarnessAcceptance_tenantId_expiresAt_idx" ON "AgentHarnessAcceptance"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessAcceptance_id_tenantId_key" ON "AgentHarnessAcceptance"("id", "tenantId");

-- AddForeignKey
ALTER TABLE "AgentHarnessScannerKey" ADD CONSTRAINT "AgentHarnessScannerKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScannerKey" ADD CONSTRAINT "AgentHarnessScannerKey_agentId_tenantId_fkey" FOREIGN KEY ("agentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScan" ADD CONSTRAINT "AgentHarnessScan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScan" ADD CONSTRAINT "AgentHarnessScan_scannerAgentId_tenantId_fkey" FOREIGN KEY ("scannerAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScan" ADD CONSTRAINT "AgentHarnessScan_scannerKeyId_tenantId_fkey" FOREIGN KEY ("scannerKeyId", "tenantId") REFERENCES "AgentHarnessScannerKey"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredAgent" ADD CONSTRAINT "DiscoveredAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredAgent" ADD CONSTRAINT "DiscoveredAgent_registeredAgentId_tenantId_fkey" FOREIGN KEY ("registeredAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScanItem" ADD CONSTRAINT "AgentHarnessScanItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScanItem" ADD CONSTRAINT "AgentHarnessScanItem_scanId_tenantId_fkey" FOREIGN KEY ("scanId", "tenantId") REFERENCES "AgentHarnessScan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessScanItem" ADD CONSTRAINT "AgentHarnessScanItem_discoveredAgentId_tenantId_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessAcceptance" ADD CONSTRAINT "AgentHarnessAcceptance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessAcceptance" ADD CONSTRAINT "AgentHarnessAcceptance_discoveredAgentId_tenantId_fkey" FOREIGN KEY ("discoveredAgentId", "tenantId") REFERENCES "DiscoveredAgent"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on all five tables
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessScannerKey" TO app_user;
ALTER TABLE "AgentHarnessScannerKey" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessScannerKey" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessScannerKey";
CREATE POLICY tenant_isolation ON "AgentHarnessScannerKey"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessScannerKey";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessScannerKey"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessScannerKey";
CREATE POLICY superuser_bypass ON "AgentHarnessScannerKey"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessScan" TO app_user;
ALTER TABLE "AgentHarnessScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessScan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessScan";
CREATE POLICY tenant_isolation ON "AgentHarnessScan"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessScan";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessScan"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessScan";
CREATE POLICY superuser_bypass ON "AgentHarnessScan"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "DiscoveredAgent" TO app_user;
ALTER TABLE "DiscoveredAgent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoveredAgent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DiscoveredAgent";
CREATE POLICY tenant_isolation ON "DiscoveredAgent"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "DiscoveredAgent";
CREATE POLICY tenant_isolation_insert ON "DiscoveredAgent"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "DiscoveredAgent";
CREATE POLICY superuser_bypass ON "DiscoveredAgent"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessScanItem" TO app_user;
ALTER TABLE "AgentHarnessScanItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessScanItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessScanItem";
CREATE POLICY tenant_isolation ON "AgentHarnessScanItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessScanItem";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessScanItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessScanItem";
CREATE POLICY superuser_bypass ON "AgentHarnessScanItem"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessAcceptance" TO app_user;
ALTER TABLE "AgentHarnessAcceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessAcceptance" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessAcceptance";
CREATE POLICY tenant_isolation ON "AgentHarnessAcceptance"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessAcceptance";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessAcceptance"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessAcceptance";
CREATE POLICY superuser_bypass ON "AgentHarnessAcceptance"
    USING (current_setting('role') != 'app_user');
