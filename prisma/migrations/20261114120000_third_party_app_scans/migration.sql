-- Third-party application scans: the ingest of the scanner's second signed
-- report, `scanent-integrations/1` — the applications a directory (Entra,
-- Okta, GitHub) has granted access to. Verified by the contract package
-- against the tenant's trusted scanner keys (the keys that sign harness
-- reports), planned by its planner, and written by
-- `usecases/third-party-app-scans.ts`, the only writer of these tables:
--
--   ThirdPartyAppScan        one verified, ingested report
--   DiscoveredThirdPartyApp  an application some scan found, across scans
--   ThirdPartyAppScanItem    one application in one scan, as planned
--
-- Identifiers, counts, the planner's conclusions and a display name. No URL,
-- no consenting person, no credential: the contract carries none of the first
-- two and only references for the third, and this ingest keeps no reference.
--
-- All three are tenant-scoped and carry the canonical RLS triple. Nothing is
-- backfilled: there is nothing to backfill.
-- CreateTable
CREATE TABLE "ThirdPartyAppScan" (
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
    "applicationCount" INTEGER NOT NULL,
    "unusedDays" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThirdPartyAppScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiscoveredThirdPartyApp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "displayName" TEXT,
    "firstSeenScanId" TEXT NOT NULL,
    "lastSeenScanId" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveredThirdPartyApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThirdPartyAppScanItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "privilege" TEXT NOT NULL,
    "usage" TEXT NOT NULL,
    "daysSinceSignIn" INTEGER,
    "classes" TEXT[],
    "grantsJson" JSONB NOT NULL,
    "publisherVerified" BOOLEAN,
    "ownerCount" INTEGER,
    "anyGrant" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThirdPartyAppScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThirdPartyAppScan_tenantId_asOf_idx" ON "ThirdPartyAppScan"("tenantId", "asOf");

-- CreateIndex
CREATE INDEX "ThirdPartyAppScan_tenantId_scannerAgentId_idx" ON "ThirdPartyAppScan"("tenantId", "scannerAgentId");

-- CreateIndex
CREATE INDEX "ThirdPartyAppScan_tenantId_scannerKeyId_idx" ON "ThirdPartyAppScan"("tenantId", "scannerKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "ThirdPartyAppScan_id_tenantId_key" ON "ThirdPartyAppScan"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ThirdPartyAppScan_tenantId_scanRef_key" ON "ThirdPartyAppScan"("tenantId", "scanRef");

-- CreateIndex
CREATE INDEX "DiscoveredThirdPartyApp_tenantId_lastSeenAt_idx" ON "DiscoveredThirdPartyApp"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredThirdPartyApp_id_tenantId_key" ON "DiscoveredThirdPartyApp"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveredThirdPartyApp_tenantId_applicationId_key" ON "DiscoveredThirdPartyApp"("tenantId", "applicationId");

-- CreateIndex
CREATE INDEX "ThirdPartyAppScanItem_tenantId_appId_idx" ON "ThirdPartyAppScanItem"("tenantId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "ThirdPartyAppScanItem_tenantId_scanId_appId_key" ON "ThirdPartyAppScanItem"("tenantId", "scanId", "appId");

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScan" ADD CONSTRAINT "ThirdPartyAppScan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScan" ADD CONSTRAINT "ThirdPartyAppScan_scannerAgentId_tenantId_fkey" FOREIGN KEY ("scannerAgentId", "tenantId") REFERENCES "RegisteredAgent"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScan" ADD CONSTRAINT "ThirdPartyAppScan_scannerKeyId_tenantId_fkey" FOREIGN KEY ("scannerKeyId", "tenantId") REFERENCES "AgentHarnessScannerKey"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiscoveredThirdPartyApp" ADD CONSTRAINT "DiscoveredThirdPartyApp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScanItem" ADD CONSTRAINT "ThirdPartyAppScanItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScanItem" ADD CONSTRAINT "ThirdPartyAppScanItem_scanId_tenantId_fkey" FOREIGN KEY ("scanId", "tenantId") REFERENCES "ThirdPartyAppScan"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyAppScanItem" ADD CONSTRAINT "ThirdPartyAppScanItem_appId_tenantId_fkey" FOREIGN KEY ("appId", "tenantId") REFERENCES "DiscoveredThirdPartyApp"("id", "tenantId") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════
-- Row-level security: the canonical triple on all three tables
-- ═══════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON "ThirdPartyAppScan" TO app_user;
ALTER TABLE "ThirdPartyAppScan" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ThirdPartyAppScan" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ThirdPartyAppScan";
CREATE POLICY tenant_isolation ON "ThirdPartyAppScan"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ThirdPartyAppScan";
CREATE POLICY tenant_isolation_insert ON "ThirdPartyAppScan"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ThirdPartyAppScan";
CREATE POLICY superuser_bypass ON "ThirdPartyAppScan"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "DiscoveredThirdPartyApp" TO app_user;
ALTER TABLE "DiscoveredThirdPartyApp" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DiscoveredThirdPartyApp" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DiscoveredThirdPartyApp";
CREATE POLICY tenant_isolation ON "DiscoveredThirdPartyApp"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "DiscoveredThirdPartyApp";
CREATE POLICY tenant_isolation_insert ON "DiscoveredThirdPartyApp"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "DiscoveredThirdPartyApp";
CREATE POLICY superuser_bypass ON "DiscoveredThirdPartyApp"
    USING (current_setting('role') != 'app_user');

GRANT SELECT, INSERT, UPDATE, DELETE ON "ThirdPartyAppScanItem" TO app_user;
ALTER TABLE "ThirdPartyAppScanItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ThirdPartyAppScanItem" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ThirdPartyAppScanItem";
CREATE POLICY tenant_isolation ON "ThirdPartyAppScanItem"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS tenant_isolation_insert ON "ThirdPartyAppScanItem";
CREATE POLICY tenant_isolation_insert ON "ThirdPartyAppScanItem"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
DROP POLICY IF EXISTS superuser_bypass ON "ThirdPartyAppScanItem";
CREATE POLICY superuser_bypass ON "ThirdPartyAppScanItem"
    USING (current_setting('role') != 'app_user');
