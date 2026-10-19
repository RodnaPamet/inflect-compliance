-- Step 4a of the agentic IAM roadmap (#3678) — client estates and their
-- scheduled scans.
--
--   AgentHarnessEstate        one client estate: a name, the registered scanner
--                             agent whose signed reports describe it, and the
--                             cadence a complete scan is expected at
--   AgentHarnessEstateSource  one source that estate's scanner reads, and the
--                             person accountable for it
--
-- Configuration: both declare what SHOULD be scanned. What WAS scanned stays on
-- AgentHarnessScan, which nothing here writes or references; the health view
-- compares the two. One estate per scanner, because a report cannot name an
-- estate (the contract is strict) and so a scan is the estate's whose scanner
-- signed it.
--
-- Identifiers, a label and a cadence. No free text, no credential. Both tables
-- are tenant-scoped and carry the canonical RLS triple. Nothing is backfilled.

-- CreateTable
CREATE TABLE "AgentHarnessEstate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scannerAgentId" TEXT NOT NULL,
    "cadenceHours" INTEGER NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentHarnessEstate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentHarnessEstateSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "estateId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentHarnessEstateSource_pkey" PRIMARY KEY ("id")
);

-- A cadence is at least hourly and at most monthly: the bounds the usecase
-- accepts, held below it.
ALTER TABLE "AgentHarnessEstate"
    ADD CONSTRAINT "AgentHarnessEstate_cadence_hours_bounded"
    CHECK ("cadenceHours" BETWEEN 1 AND 720);

-- The contract's source kinds (`SOURCE_KINDS` in
-- src/lib/agentic/harness-contract.ts), pinned so a source the contract cannot
-- report can never be declared. A new kind is a new contract id first.
ALTER TABLE "AgentHarnessEstateSource"
    ADD CONSTRAINT "AgentHarnessEstateSource_kind_known"
    CHECK ("kind" IN ('entra-sp', 'okta-app', 'vault', 'mcp', 'runtime', 'cicd', 'inflect-register'));

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessEstate_id_tenantId_key" ON "AgentHarnessEstate"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessEstate_tenantId_scannerAgentId_key" ON "AgentHarnessEstate"("tenantId", "scannerAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessEstate_tenantId_name_key" ON "AgentHarnessEstate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AgentHarnessEstateSource_tenantId_ownerUserId_idx" ON "AgentHarnessEstateSource"("tenantId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentHarnessEstateSource_tenantId_estateId_kind_key" ON "AgentHarnessEstateSource"("tenantId", "estateId", "kind");

-- AddForeignKey
ALTER TABLE "AgentHarnessEstate" ADD CONSTRAINT "AgentHarnessEstate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessEstate" ADD CONSTRAINT "AgentHarnessEstate_scannerAgentId_tenantId_fkey" FOREIGN KEY ("scannerAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessEstateSource" ADD CONSTRAINT "AgentHarnessEstateSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessEstateSource" ADD CONSTRAINT "AgentHarnessEstateSource_estateId_tenantId_fkey" FOREIGN KEY ("estateId", "tenantId") REFERENCES "AgentHarnessEstate"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentHarnessEstateSource" ADD CONSTRAINT "AgentHarnessEstateSource_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on both tables
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessEstate" TO app_user;
ALTER TABLE "AgentHarnessEstate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessEstate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessEstate";
CREATE POLICY tenant_isolation ON "AgentHarnessEstate"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessEstate";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessEstate"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessEstate";
CREATE POLICY superuser_bypass ON "AgentHarnessEstate"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentHarnessEstateSource" TO app_user;
ALTER TABLE "AgentHarnessEstateSource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentHarnessEstateSource" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentHarnessEstateSource";
CREATE POLICY tenant_isolation ON "AgentHarnessEstateSource"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentHarnessEstateSource";
CREATE POLICY tenant_isolation_insert ON "AgentHarnessEstateSource"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentHarnessEstateSource";
CREATE POLICY superuser_bypass ON "AgentHarnessEstateSource"
    USING (current_setting('role') != 'app_user');
