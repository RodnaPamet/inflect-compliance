-- Agent-surface rules scans: the ingest of the scanner's third signed report,
-- `scanent-agent-rules/1` — what static rules found written into the MCP tool
-- definitions and the agent skills a scanner read. Verified by the contract package against the
-- tenant's trusted scanner keys (the keys that sign harness reports), planned
-- by its planner, and written by `usecases/agent-rule-scans.ts`, the only
-- writer of these tables:
--
--   AgentRuleScan      one verified, ingested report, with the origins it read
--   AgentRuleScanItem  one finding in one scan: which origin it was read from,
--                      which is how a later scan knows what it may close
--
-- Identifiers only: rule ids, codes, MCP server and tool references, code root
-- labels and skill paths, locators. The report carries no text of a tool's
-- definition, a skill or a script, and this ingest keeps none.
--
-- Both are tenant-scoped and carry the canonical RLS triple. Nothing is
-- backfilled: there is nothing to backfill.
-- CreateTable
CREATE TABLE "AgentRuleScan" (
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
    "outcome" TEXT NOT NULL,
    "populationJson" JSONB NOT NULL,
    "originsJson" JSONB NOT NULL,
    "subjects" INTEGER NOT NULL,
    "flagged" INTEGER NOT NULL,
    "findingCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRuleScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRuleScanItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "originRef" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "subjectRef" TEXT NOT NULL,
    "locator" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRuleScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentRuleScan_tenantId_asOf_idx" ON "AgentRuleScan"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "AgentRuleScan_tenantId_scannerAgentId_idx" ON "AgentRuleScan"("tenantId", "scannerAgentId");

-- CreateIndex
CREATE INDEX "AgentRuleScan_tenantId_scannerKeyId_idx" ON "AgentRuleScan"("tenantId", "scannerKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuleScan_id_tenantId_key" ON "AgentRuleScan"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuleScan_tenantId_scanRef_key" ON "AgentRuleScan"("tenantId", "scanRef");

-- CreateIndex
CREATE INDEX "AgentRuleScanItem_tenantId_sourceRef_idx" ON "AgentRuleScanItem"("tenantId", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuleScanItem_tenantId_scanId_sourceRef_key" ON "AgentRuleScanItem"("tenantId", "scanId", "sourceRef");

-- AddForeignKey
ALTER TABLE "AgentRuleScan" ADD CONSTRAINT "AgentRuleScan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuleScan" ADD CONSTRAINT "AgentRuleScan_scannerAgentId_tenantId_fkey" FOREIGN KEY ("scannerAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuleScan" ADD CONSTRAINT "AgentRuleScan_scannerKeyId_tenantId_fkey" FOREIGN KEY ("scannerKeyId", "tenantId") REFERENCES "AgentHarnessScannerKey"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuleScanItem" ADD CONSTRAINT "AgentRuleScanItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRuleScanItem" ADD CONSTRAINT "AgentRuleScanItem_scanId_tenantId_fkey" FOREIGN KEY ("scanId", "tenantId") REFERENCES "AgentRuleScan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on both tables
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentRuleScan" TO app_user;
ALTER TABLE "AgentRuleScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRuleScan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentRuleScan";
CREATE POLICY tenant_isolation ON "AgentRuleScan"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentRuleScan";
CREATE POLICY tenant_isolation_insert ON "AgentRuleScan"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentRuleScan";
CREATE POLICY superuser_bypass ON "AgentRuleScan"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "AgentRuleScanItem" TO app_user;
ALTER TABLE "AgentRuleScanItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgentRuleScanItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AgentRuleScanItem";
CREATE POLICY tenant_isolation ON "AgentRuleScanItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "AgentRuleScanItem";
CREATE POLICY tenant_isolation_insert ON "AgentRuleScanItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "AgentRuleScanItem";
CREATE POLICY superuser_bypass ON "AgentRuleScanItem"
    USING (current_setting('role') != 'app_user');
