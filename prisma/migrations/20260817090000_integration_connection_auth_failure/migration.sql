-- H1-3: surface a revoked credential on the connection itself.
--
-- Background syncs previously recorded an auth failure only on
-- IntegrationExecution. IntegrationConnection carries lastTestedAt /
-- lastTestStatus, but those belong to the operator-initiated "Test connection"
-- button and are never written by a background sync — so a connection whose
-- token was revoked months ago still presented as healthy.
--
-- Two nullable columns, no default, no backfill: NULL means "no credential
-- failure observed", which is the correct reading for every existing row
-- (we have not observed one). Additive and safe to deploy ahead of the app —
-- old containers simply ignore the columns.
--
-- Rollback: DROP COLUMN both. No data depends on them; the app treats NULL as
-- healthy, so a rollback degrades to the pre-migration behaviour exactly.

ALTER TABLE "IntegrationConnection"
    ADD COLUMN "authFailedAt" TIMESTAMP(3),
    ADD COLUMN "authFailureReason" TEXT;
