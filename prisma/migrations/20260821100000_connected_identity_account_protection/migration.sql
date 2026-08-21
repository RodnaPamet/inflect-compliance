-- ConnectedIdentityAccount protection flag — the break-glass rail's producer.
--
-- WHY. `disableAccount` has refused protected accounts since #2036, with the
-- refusal, the reason and the outcome all in place — and nothing ever set the
-- flag, so the rail was inert. `DisableAccountInput.isProtected` had no producer
-- at all. Under the DRY_RUN clamp that was tolerable: such an account is
-- reported as would-be-disabled and an operator reading the pass sees it. It
-- stops being tolerable the moment a tenant is promoted, because then the first
-- AUTOMATIC run disables a break-glass credential with nothing in front of it.
--
-- ADDITIVE AND FORWARD-COMPATIBLE. `isProtected` takes a NOT NULL DEFAULT false,
-- so every existing row acquires the safe value without a backfill and an old
-- container mid-rolling-deploy neither reads nor writes any of these columns.
-- The other three are nullable.
--
-- THE DEFAULT IS THE SAFE DIRECTION HERE, AND THAT IS WORTH STATING: an account
-- that nobody has protected is offboardable, which is the behaviour that exists
-- today. Defaulting to true would silently switch offboarding off for every
-- account in the estate — a rail that refuses everything is as broken as one
-- that refuses nothing, and far harder to notice.
--
-- ROLLBACK. Drop the four columns; nothing in the previous image reads them:
--   ALTER TABLE "ConnectedIdentityAccount"
--     DROP COLUMN IF EXISTS "isProtected",
--     DROP COLUMN IF EXISTS "protectedAt",
--     DROP COLUMN IF EXISTS "protectedByUserId",
--     DROP COLUMN IF EXISTS "protectionReason";
-- Note this DISCARDS the operator's protected set. Before rolling back past
-- this migration, export it — the list is customer knowledge that nothing else
-- in the product holds.
--
-- RLS. Unchanged. tenant_isolation / tenant_isolation_insert / superuser_bypass
-- quote only "tenantId", and grants are table-level, so the new columns are
-- covered without re-CREATEing anything.
--
-- IF NOT EXISTS throughout, so a re-run against a partially-migrated database is
-- a no-op rather than a failed deploy.

ALTER TABLE "ConnectedIdentityAccount"
    ADD COLUMN IF NOT EXISTS "isProtected" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "protectedAt" TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "protectedByUserId" TEXT,
    ADD COLUMN IF NOT EXISTS "protectionReason" TEXT;
