-- ConnectedIdentityAccount — phase 2: the grain becomes the CONNECTION.
--
-- Phase 1 (20260821020000) added `connectionId` as NULLABLE and deliberately left
-- the old `(tenantId, provider, externalUserId)` unique in place, because the
-- containers running during that rolling deploy upserted through it and knew
-- nothing about the new column. This is the second half, and it could not have
-- shared that deploy.
--
-- WHY THE WINDOW IS SAFE, stated rather than assumed. Dropping the old unique
-- breaks the phase-1 image's upsert key, so in principle there is a window where
-- a still-running old container cannot write. Measured in production before
-- writing this: ZERO IntegrationConnection rows of any provider and ZERO
-- ConnectedIdentityAccount rows. No sync runs, so the upsert path is never
-- exercised and the window is empty. That is the same argument that made phase 1
-- free, and it closes the day a customer connects a directory — which is why
-- both halves are being taken now.
--
-- `SET NOT NULL` WILL FAIL LOUDLY if any row still carries a NULL, and that is
-- the intended behaviour rather than an oversight: a row that cannot say which
-- directory it came from is exactly what this column exists to prevent, and
-- guessing one during a migration would write the wrong attribution
-- permanently. If this statement aborts a deploy, resolve it by hand — attribute
-- the rows to their connection, or delete them if the connection is gone — and
-- re-run. The backfill below is re-applied first so that only genuinely
-- unattributable rows can reach it.
--
-- THE FK BECOMES CASCADE. With the column required, an orphan cannot be
-- represented, so `ON DELETE SET NULL` is no longer a legal outcome. Deleting a
-- connection now deletes the roster it observed — the truthful result, since
-- those rows were only ever that connection's account of a directory it no
-- longer reaches. Note this is a REAL behaviour change for connection deletion.
--
-- ROLLBACK. Reverse in this order:
--   ALTER TABLE "ConnectedIdentityAccount" DROP CONSTRAINT IF EXISTS "ConnectedIdentityAccount_connectionId_fkey";
--   ALTER TABLE "ConnectedIdentityAccount" ADD CONSTRAINT "ConnectedIdentityAccount_connectionId_fkey"
--     FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
--   DROP INDEX IF EXISTS "ConnectedIdentityAccount_tenantId_connectionId_externalUser_key";
--   CREATE UNIQUE INDEX "ConnectedIdentityAccount_tenantId_provider_externalUserId_key"
--     ON "ConnectedIdentityAccount" ("tenantId", "provider", "externalUserId");
--   ALTER TABLE "ConnectedIdentityAccount" ALTER COLUMN "connectionId" DROP NOT NULL;
-- The old unique can only be recreated if no two rows now share
-- (tenantId, provider, externalUserId) — which two connections to different
-- forests legitimately can. Rolling back after such a tenant exists needs those
-- rows resolved first.
--
-- RLS unchanged: the policies quote only "tenantId".

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

ALTER TABLE "ConnectedIdentityAccount" ALTER COLUMN "connectionId" SET NOT NULL;

DROP INDEX IF EXISTS "ConnectedIdentityAccount_tenantId_provider_externalUserId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "ConnectedIdentityAccount_tenantId_connectionId_externalUser_key"
  ON "ConnectedIdentityAccount" ("tenantId", "connectionId", "externalUserId");

ALTER TABLE "ConnectedIdentityAccount"
    DROP CONSTRAINT IF EXISTS "ConnectedIdentityAccount_connectionId_fkey";
ALTER TABLE "ConnectedIdentityAccount"
    ADD CONSTRAINT "ConnectedIdentityAccount_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
