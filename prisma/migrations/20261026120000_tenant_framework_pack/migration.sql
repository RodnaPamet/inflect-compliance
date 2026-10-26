-- The packs a workspace installed, so a framework that offers more than one
-- pack can be scoped to the ones the workspace chose.
--
-- EU drone operations ships one pack per operating subcategory, and install
-- requires choosing at least one. Until now nothing recorded the choice: the
-- install wrote controls and a FRAMEWORK_PACK_INSTALLED audit row, and coverage
-- divided by every requirement in the framework. A workspace that flies only in
-- subcategory A2 saw the specific-category sections as unmapped gaps it never
-- took on. The coverage surfaces now read this table
-- (`usecases/framework/pack-scope.ts`); a single-pack framework, and a
-- workspace with no row for a framework, are never narrowed.
--
-- Additive: a new table nothing else depends on. Rolling back the code leaves
-- the table unread and harmless.

-- CreateTable
CREATE TABLE "TenantFrameworkPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "frameworkId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantFrameworkPack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantFrameworkPack_tenantId_frameworkId_idx" ON "TenantFrameworkPack"("tenantId", "frameworkId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFrameworkPack_tenantId_packId_key" ON "TenantFrameworkPack"("tenantId", "packId");

-- AddForeignKey
ALTER TABLE "TenantFrameworkPack" ADD CONSTRAINT "TenantFrameworkPack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantFrameworkPack" ADD CONSTRAINT "TenantFrameworkPack_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "Framework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantFrameworkPack" ADD CONSTRAINT "TenantFrameworkPack_packId_fkey" FOREIGN KEY ("packId") REFERENCES "FrameworkPack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill from the audit trail, before RLS is switched on. Every pack install
-- has written a FRAMEWORK_PACK_INSTALLED row carrying `metadataJson.packKey`
-- since packs existed, so a workspace that installed packs before this table
-- keeps its choice rather than being widened to the whole framework. A pack key
-- the catalogue no longer has is skipped by the join; the earliest install of
-- each pack dates the row. The id is deterministic so a re-run inserts nothing.
INSERT INTO "TenantFrameworkPack" ("id", "tenantId", "frameworkId", "packId", "createdAt")
SELECT DISTINCT ON (a."tenantId", p."id")
       'tfp_' || md5(a."tenantId" || ':' || p."id"),
       a."tenantId",
       p."frameworkId",
       p."id",
       a."createdAt"
FROM "AuditLog" a
JOIN "FrameworkPack" p ON p."key" = a."metadataJson"->>'packKey'
JOIN "Tenant" t ON t."id" = a."tenantId"
WHERE a."action" = 'FRAMEWORK_PACK_INSTALLED'
ORDER BY a."tenantId", p."id", a."createdAt" ASC
ON CONFLICT ("tenantId", "packId") DO NOTHING;

-- Row-level security, the canonical Class-A shape (docs/rls-tenant-isolation.md).
ALTER TABLE "TenantFrameworkPack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantFrameworkPack" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "TenantFrameworkPack"
    USING ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY tenant_isolation_insert ON "TenantFrameworkPack"
    FOR INSERT WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::text);
CREATE POLICY superuser_bypass ON "TenantFrameworkPack"
    USING (current_setting('role') != 'app_user');
