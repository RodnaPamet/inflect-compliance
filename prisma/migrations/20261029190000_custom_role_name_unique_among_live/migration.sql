-- A custom role's name is unique among LIVE roles only (#4467; owner
-- decision, 2026-10-29), so a deleted role frees its name.
--
-- Deleting a custom role is a soft delete: `deleteCustomRole` sets
-- "isActive" = false and the page stops listing it. The full unique index on
-- ("tenantId", "name") still counted the deleted row, so the name could never
-- be used again while no role holding it was visible anywhere.
--
-- Modelled on Asset's 20260312210616_partial_unique_soft_delete: the full
-- unique index is replaced by a partial one under the SAME name, and a plain
-- lookup index backs the usecases' duplicate check. Prisma cannot declare a
-- filtered index, so prisma/schema/auth.prisma carries the plain index and a
-- comment saying where the uniqueness lives.
--
-- No live duplicate can exist when this runs: the index being dropped held
-- across every row, live or deleted, so no two rows in a tenant share a name
-- at all. DROP INDEX takes an ACCESS EXCLUSIVE lock on the table, held until
-- the migration commits, so nothing can insert between the drop and the
-- build, and the build cannot fail on a duplicate.

-- 1. Replace the full unique index with a partial one over live roles.
DROP INDEX IF EXISTS "TenantCustomRole_tenantId_name_key";
CREATE UNIQUE INDEX "TenantCustomRole_tenantId_name_key"
    ON "TenantCustomRole"("tenantId", "name")
    WHERE "isActive";

-- 2. The plain lookup index the schema declares (`@@index([tenantId, name])`).
CREATE INDEX "TenantCustomRole_tenantId_name_idx"
    ON "TenantCustomRole"("tenantId", "name");
