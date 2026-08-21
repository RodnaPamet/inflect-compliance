-- ConnectedIdentityAccount.connectionId — which connection's sync observed this account.
--
-- WHY. IntegrationConnection is unique on (tenantId, provider, NAME), so one tenant
-- may hold two AD forests or two Entra tenants. The nightly deprovision reconcile
-- could only scope itself by `provider`, so connection A's pass marked every account
-- belonging to connection B as DEPROVISIONED, then B's pass did the reverse — both
-- reporting PASSED. It needed no write permission, no consent and no bind; any admin
-- creating a second connection triggered it, and nothing refused.
--
-- ADDITIVE AND FORWARD-COMPATIBLE. A nullable column with no default: an old container
-- mid-rolling-deploy neither reads nor writes it, and its upsert key
-- (tenantId, provider, externalUserId) is deliberately left in place by this migration.
-- Swapping that unique to (tenantId, connectionId, externalUserId) and making the column
-- NOT NULL is a SECOND migration, taken only once every container serves the new code
-- and a production count of NULLs is zero. Dropping the old unique here would fail the
-- old containers' writes outright.
--
-- BACKFILL. Only where the (tenantId, provider) pair resolves to exactly ONE connection,
-- because that is the only case where the answer is knowable. A tenant with two
-- connections is precisely the tenant this column exists to disambiguate, and guessing
-- there would write the same wrong attribution the bug was made of. Those rows stay NULL
-- and are adopted by whichever connection next observes them.
--
-- ROLLBACK. Drop the constraint, the index and the column; nothing reads it in the
-- previous image:
--   ALTER TABLE "ConnectedIdentityAccount" DROP CONSTRAINT IF EXISTS "ConnectedIdentityAccount_connectionId_fkey";
--   DROP INDEX IF EXISTS "ConnectedIdentityAccount_tenantId_connectionId_idx";
--   ALTER TABLE "ConnectedIdentityAccount" DROP COLUMN IF EXISTS "connectionId";
--
-- RLS. Unchanged. The tenant_isolation / tenant_isolation_insert / superuser_bypass
-- policies quote only "tenantId", and grants are table-level, so the new column is
-- covered without re-CREATEing anything.
--
-- IF NOT EXISTS / DO-block guards throughout, so a re-run against a partially-migrated
-- database is a no-op rather than a failed deploy.

ALTER TABLE "ConnectedIdentityAccount" ADD COLUMN IF NOT EXISTS "connectionId" TEXT;

UPDATE "ConnectedIdentityAccount" a
SET "connectionId" = c."id"
FROM "IntegrationConnection" c
WHERE a."connectionId" IS NULL
  AND c."tenantId" = a."tenantId"
  AND c."provider" = a."provider"
  AND (
    SELECT COUNT(*) FROM "IntegrationConnection" c2
    WHERE c2."tenantId" = a."tenantId" AND c2."provider" = a."provider"
  ) = 1;

CREATE INDEX IF NOT EXISTS "ConnectedIdentityAccount_tenantId_connectionId_idx"
  ON "ConnectedIdentityAccount" ("tenantId", "connectionId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ConnectedIdentityAccount_connectionId_fkey'
    ) THEN
        ALTER TABLE "ConnectedIdentityAccount"
            ADD CONSTRAINT "ConnectedIdentityAccount_connectionId_fkey"
            FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;
