-- H3-2: resume a directory enumeration that exceeds MAX_USERS.
--
-- A directory larger than the 5000-account cap could never finish: every run
-- started at page one and stopped in exactly the same place, so accounts past
-- the cap were never synced and the deprovision reconcile was skipped forever.
-- The providers already computed a continuation token at the truncation point
-- and threw it away.
--
-- syncCursor        — the provider's opaque continuation.
-- syncPassStartedAt — when the current multi-run pass began. The reconcile
--                     compares ConnectedIdentityAccount.syncedAt against this,
--                     so "seen" accumulates across every run in the pass rather
--                     than resetting each run.
--
-- Two nullable columns, no default, no backfill: both NULL means "no pass in
-- flight", the correct reading for every existing row. Additive and safe to
-- deploy ahead of the app — old containers ignore them and keep the current
-- single-run behaviour.
--
-- Rollback: DROP COLUMN both. Enumeration reverts to restarting each run and
-- truncating at the cap, i.e. exactly the pre-migration behaviour.

ALTER TABLE "IntegrationConnection"
    ADD COLUMN "syncCursor" TEXT,
    ADD COLUMN "syncPassStartedAt" TIMESTAMP(3);
