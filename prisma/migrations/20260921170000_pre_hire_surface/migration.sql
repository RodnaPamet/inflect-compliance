-- JML joiner Phase 2c — the PRE-HIRE surface (#2715).
--
-- Owner decision 2: pre-hires live OUTSIDE `Employee`, in their own model,
-- with a pending-state surface. `Employee.workEmail` is NOT migrated: it is
-- `String` NOT NULL with `@@unique([tenantId, workEmail])`, and that key is
-- what the idempotent HRIS upsert addresses rows by. Relaxing it to serve a
-- feature that does not exist yet trades a guarantee the ingest relies on for
-- a convenience.

CREATE TYPE "PreHireStatus" AS ENUM ('PENDING', 'RECONCILED', 'CANCELLED');

CREATE TABLE "PreHire" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "department" TEXT,
    "startDate" TIMESTAMP(3),
    "intendedAddress" TEXT,
    "status" "PreHireStatus" NOT NULL DEFAULT 'PENDING',
    "reconciledEmployeeId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreHire_pkey" PRIMARY KEY ("id")
);

-- One pre-hire per HRIS identifier per tenant. A second row for the same
-- person is the duplicate this model exists to avoid, arriving by another door.
CREATE UNIQUE INDEX "PreHire_tenantId_externalId_key" ON "PreHire"("tenantId", "externalId");

CREATE INDEX "PreHire_tenantId_idx" ON "PreHire"("tenantId");

ALTER TABLE "PreHire"
    ADD CONSTRAINT "PreHire_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS TRIO. `TENANT_SCOPED_MODELS` is DMMF-derived, so this table joins the
-- RLS-enforced set the moment it has a tenantId; rls-coverage fails without
-- these three.
ALTER TABLE "PreHire" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PreHire" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "PreHire"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY tenant_isolation_insert ON "PreHire"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);

CREATE POLICY superuser_bypass ON "PreHire"
    USING (current_setting('role') != 'app_user');
