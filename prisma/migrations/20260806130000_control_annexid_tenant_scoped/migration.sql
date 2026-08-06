-- Control.annexId — make uniqueness tenant-scoped.
--
-- THE DEFECT
-- ----------
-- `annexId String? @unique` compiled to a GLOBAL unique index
-- (Control_annexId_key, migration 20260308190244_init:690). But annexId is
-- the framework's annex reference — 'A.5.1', 'A.8.2' — which every tenant
-- adopting ISO 27001 will use, and it IS written on tenant-owned rows
-- (CreateControlSchema accepts it, mutations.ts writes it, seed.ts seeds it
-- per tenant after a TENANT-SCOPED existence check the global constraint
-- ignores).
--
-- So the first tenant to claim 'A.5.1' permanently blocked every other
-- tenant; seeding a second tenant with the ISO annex set failed P2002; and
-- the resulting 500 was a cross-tenant existence oracle — you could probe
-- which annex references another tenant had adopted.
--
-- THE FIX, AND THE GLOBAL LIBRARY
-- -------------------------------
-- Tenant rows move to UNIQUE (tenantId, annexId), matching the
-- @@unique([tenantId, key]) pattern Asset uses.
--
-- That composite CANNOT constrain the shared catalogue, because Postgres
-- treats NULLs as distinct in a unique index: (NULL,'A.5.1') twice does not
-- collide. The global library should still hold one control per annex
-- reference, so that half is enforced by a PARTIAL unique index on annexId
-- WHERE "tenantId" IS NULL. Prisma cannot express a filtered index, so it
-- lives here and is documented in controls.prisma.
--
-- Net effect: tenants are free of each other, the shared catalogue keeps
-- the guarantee the original constraint was presumably reaching for.

DROP INDEX IF EXISTS "Control_annexId_key";

-- Tenant-owned rows: one control per annex reference per tenant.
CREATE UNIQUE INDEX "Control_tenantId_annexId_key"
    ON "Control"("tenantId", "annexId");

-- Shared catalogue: one control per annex reference, globally.
-- (Partial, because the composite above cannot see NULL tenants.)
CREATE UNIQUE INDEX "Control_annexId_global_key"
    ON "Control"("annexId")
    WHERE "tenantId" IS NULL;
