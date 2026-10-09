-- Legacy access recertification, Step 2a — snapshot models.
--
-- Additive and forward-only (global rule 9): every new column on an existing
-- table is nullable or defaulted, so a rolling deploy's still-running old
-- containers keep working against the new shape. No enum value is renamed or
-- dropped anywhere in this migration, for the reason the `PROPOSE` rung
-- records: Postgres cannot drop an enum value without recreating the type, and
-- an `ALTER TYPE` mid-deploy fails old containers with SQLSTATE 42704.

-- CreateEnum
CREATE TYPE "LegacyAccessSnapshotStatus" AS ENUM ('PENDING', 'COMPLETE', 'PARTIAL');

CREATE TYPE "LegacyAccessRefusalReason" AS ENUM ('AUTHENTICATION_FAILED', 'SSRF_BLOCKED', 'TIMEOUT', 'CONTRACT_VIOLATION', 'CAP_EXCEEDED', 'TORN_SNAPSHOT', 'INCOMPLETE_READ', 'SCHEMA_DRIFT', 'AMBIGUOUS_COLUMN_CASE', 'MISSING_ACCOUNT_KEY', 'DUPLICATE_ACCOUNT_KEY', 'CONTRADICTORY_ROWS', 'SECRET_SHAPED_VALUE', 'ROW_SCHEMA_INVALID', 'MAPPING_MISSING', 'MAPPING_UNUSABLE', 'INTERNAL_ERROR');

CREATE TYPE "LegacyAccountStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED', 'EXPIRED', 'UNKNOWN');

CREATE TYPE "LegacyAccountType" AS ENUM ('HUMAN', 'SERVICE', 'SHARED', 'SYSTEM', 'UNKNOWN');

-- AlterTable — the OVERSHARING flag, on the connection so an operator sees a
-- misbehaving server without opening a snapshot.
ALTER TABLE "IntegrationConnection" ADD COLUMN "oversharingObservedAt" TIMESTAMP(3);
ALTER TABLE "IntegrationConnection" ADD COLUMN "oversharingColumns" TEXT[];

-- CreateTable
CREATE TABLE "LegacyAccessSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "remoteSnapshotId" TEXT NOT NULL,
    "mappingVersion" INTEGER NOT NULL,
    "columnSetFingerprint" TEXT NOT NULL,
    "payloadHash" TEXT,
    "payloadHashAlgorithmVersion" INTEGER NOT NULL DEFAULT 1,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "rowsReceived" INTEGER NOT NULL DEFAULT 0,
    "status" "LegacyAccessSnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "refusalReason" "LegacyAccessRefusalReason",
    "refusalDetail" TEXT,
    "oversharedColumns" TEXT[],
    "unparsedDateCount" INTEGER NOT NULL DEFAULT 0,
    "pulledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyAccessSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyAccount" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "username" TEXT,
    "displayName" TEXT,
    "givenName" TEXT,
    "familyName" TEXT,
    "email" TEXT,
    "employeeNumber" TEXT,
    "department" TEXT,
    "title" TEXT,
    "managerRef" TEXT,
    "status" "LegacyAccountStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastLoginAt" TIMESTAMP(3),
    "sourceCreatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "entitlements" TEXT[],
    "isPrivileged" BOOLEAN,
    "accountType" "LegacyAccountType" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegacyAccessSnapshot_id_tenantId_key" ON "LegacyAccessSnapshot"("id", "tenantId");

-- CreateIndex
CREATE INDEX "LegacyAccessSnapshot_tenantId_idx" ON "LegacyAccessSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "LegacyAccessSnapshot_tenantId_connectionId_status_pulledAt_idx" ON "LegacyAccessSnapshot"("tenantId", "connectionId", "status", "pulledAt");

-- CreateIndex
CREATE INDEX "LegacyAccessSnapshot_tenantId_connectionId_completedAt_idx" ON "LegacyAccessSnapshot"("tenantId", "connectionId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyAccount_snapshotId_accountKey_key" ON "LegacyAccount"("snapshotId", "accountKey");

-- CreateIndex
CREATE INDEX "LegacyAccount_tenantId_idx" ON "LegacyAccount"("tenantId");

-- CreateIndex
CREATE INDEX "LegacyAccount_tenantId_snapshotId_accountKey_idx" ON "LegacyAccount"("tenantId", "snapshotId", "accountKey");

-- CreateIndex
CREATE INDEX "LegacyAccount_tenantId_email_idx" ON "LegacyAccount"("tenantId", "email");

-- CreateIndex
CREATE INDEX "LegacyAccount_tenantId_employeeNumber_idx" ON "LegacyAccount"("tenantId", "employeeNumber");

-- AddForeignKey
ALTER TABLE "LegacyAccessSnapshot" ADD CONSTRAINT "LegacyAccessSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyAccessSnapshot" ADD CONSTRAINT "LegacyAccessSnapshot_connectionId_tenantId_fkey" FOREIGN KEY ("connectionId", "tenantId") REFERENCES "IntegrationConnection"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyAccount" ADD CONSTRAINT "LegacyAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyAccount" ADD CONSTRAINT "LegacyAccount_snapshotId_tenantId_fkey" FOREIGN KEY ("snapshotId", "tenantId") REFERENCES "LegacyAccessSnapshot"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security
--
-- The canonical triple on both tables: ENABLE + FORCE, a `tenant_isolation`
-- USING policy, a `tenant_isolation_insert` WITH CHECK policy, and
-- `superuser_bypass`. `tenantId` is NOT NULL on both, so the split
-- USING / WITH CHECK form is correct — the single asymmetric policy
-- `UserSession` carries exists only because its `tenantId` is nullable.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "LegacyAccessSnapshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegacyAccessSnapshot" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "LegacyAccessSnapshot";
CREATE POLICY tenant_isolation ON "LegacyAccessSnapshot"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "LegacyAccessSnapshot";
CREATE POLICY tenant_isolation_insert ON "LegacyAccessSnapshot"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "LegacyAccessSnapshot";
CREATE POLICY superuser_bypass ON "LegacyAccessSnapshot"
    USING (current_setting('role') != 'app_user');

ALTER TABLE "LegacyAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LegacyAccount" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "LegacyAccount";
CREATE POLICY tenant_isolation ON "LegacyAccount"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS tenant_isolation_insert ON "LegacyAccount";
CREATE POLICY tenant_isolation_insert ON "LegacyAccount"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

DROP POLICY IF EXISTS superuser_bypass ON "LegacyAccount";
CREATE POLICY superuser_bypass ON "LegacyAccount"
    USING (current_setting('role') != 'app_user');
