-- Legacy access recertification, Step 3c — per-run resolutions and the durable
-- crosswalk.
--
-- Additive and forward-only (global rule 9). Nothing is renamed, nothing
-- dropped, no enum value removed. The one change to an existing table is a new
-- UNIQUE INDEX on `IntegrationExecution(id, tenantId)`, which is trivially
-- satisfiable because `id` is already the primary key — no existing row can
-- violate it, and it exists so a child row's foreign key can be composite,
-- making a cross-tenant pointer unrepresentable rather than merely checked.

-- CreateEnum
CREATE TYPE "LegacyResolutionOutcome" AS ENUM ('LINKED', 'SUGGESTED', 'AMBIGUOUS', 'UNMATCHED', 'NON_PERSON');

CREATE TYPE "LegacyMatchMethod" AS ENUM ('CONFIRMED_ALIAS', 'EMPLOYEE_NUMBER', 'EMAIL_EXACT', 'DIRECTORY_BRIDGE', 'NON_PERSON_RULE', 'REKEYED_PERSON_RULE', 'SUPPORTING_ONLY', 'STRONG_SIGNAL_TIE', 'VETOED', 'NO_STRONG_SIGNAL', 'NO_CANDIDATES');

CREATE TYPE "LegacyAliasStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateIndex — the composite-FK target. See the header.
CREATE UNIQUE INDEX "IntegrationExecution_id_tenantId_key" ON "IntegrationExecution"("id", "tenantId");

-- CreateTable
CREATE TABLE "LegacyAccountResolution" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "outcome" "LegacyResolutionOutcome" NOT NULL,
    "method" "LegacyMatchMethod" NOT NULL,
    "employeeId" TEXT,
    "signalsJson" JSONB NOT NULL,
    "candidatesJson" JSONB NOT NULL,
    "vetoesJson" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyAccountResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyIdentityAlias" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "method" "LegacyMatchMethod" NOT NULL,
    "status" "LegacyAliasStatus" NOT NULL DEFAULT 'ACTIVE',
    "confirmedByUserId" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "signalsJson" JSONB NOT NULL,
    "suspendedReason" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyIdentityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegacyAccountResolution_executionId_accountKey_key" ON "LegacyAccountResolution"("executionId", "accountKey");

-- CreateIndex
CREATE INDEX "LegacyAccountResolution_tenantId_idx" ON "LegacyAccountResolution"("tenantId");

-- CreateIndex
CREATE INDEX "LegacyAccountResolution_tenantId_snapshotId_outcome_idx" ON "LegacyAccountResolution"("tenantId", "snapshotId", "outcome");

-- CreateIndex
CREATE INDEX "LegacyAccountResolution_tenantId_employeeId_idx" ON "LegacyAccountResolution"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyIdentityAlias_connectionId_accountKey_key" ON "LegacyIdentityAlias"("connectionId", "accountKey");

-- CreateIndex
CREATE INDEX "LegacyIdentityAlias_tenantId_idx" ON "LegacyIdentityAlias"("tenantId");

-- CreateIndex
CREATE INDEX "LegacyIdentityAlias_tenantId_connectionId_status_idx" ON "LegacyIdentityAlias"("tenantId", "connectionId", "status");

-- CreateIndex
CREATE INDEX "LegacyIdentityAlias_tenantId_employeeId_idx" ON "LegacyIdentityAlias"("tenantId", "employeeId");

-- AddForeignKey
ALTER TABLE "LegacyAccountResolution" ADD CONSTRAINT "LegacyAccountResolution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyAccountResolution" ADD CONSTRAINT "LegacyAccountResolution_executionId_tenantId_fkey" FOREIGN KEY ("executionId", "tenantId") REFERENCES "IntegrationExecution"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyAccountResolution" ADD CONSTRAINT "LegacyAccountResolution_snapshotId_tenantId_fkey" FOREIGN KEY ("snapshotId", "tenantId") REFERENCES "LegacyAccessSnapshot"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyIdentityAlias" ADD CONSTRAINT "LegacyIdentityAlias_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyIdentityAlias" ADD CONSTRAINT "LegacyIdentityAlias_connectionId_tenantId_fkey" FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security
--
-- The canonical triple on both tables. `tenantId` is NOT NULL on both, so the
-- split USING / WITH CHECK form is correct — the single asymmetric policy
-- `UserSession` carries exists only because its `tenantId` is nullable.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "LegacyAccountResolution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegacyAccountResolution" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "LegacyAccountResolution";
CREATE POLICY tenant_isolation ON "LegacyAccountResolution"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "LegacyAccountResolution";
CREATE POLICY tenant_isolation_insert ON "LegacyAccountResolution"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "LegacyAccountResolution";
CREATE POLICY superuser_bypass ON "LegacyAccountResolution"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "LegacyIdentityAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegacyIdentityAlias" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "LegacyIdentityAlias";
CREATE POLICY tenant_isolation ON "LegacyIdentityAlias"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "LegacyIdentityAlias";
CREATE POLICY tenant_isolation_insert ON "LegacyIdentityAlias"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "LegacyIdentityAlias";
CREATE POLICY superuser_bypass ON "LegacyIdentityAlias"
    USING (current_setting('role') != 'app_user');
