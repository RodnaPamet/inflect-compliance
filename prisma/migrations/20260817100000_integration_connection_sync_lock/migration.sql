-- H2-3: per-connection sync lease.
--
-- Two concurrent syncs for one connection corrupt data rather than merely
-- duplicating work: the SharePoint delta importer reads and writes its delta
-- token in separate transactions, and `importOne` always creates a NEW Evidence
-- row (only the mapping is upserted). The same file therefore becomes two
-- Evidence rows and one mapping, leaving an orphaned copy with no provenance.
--
-- Reachable today by double-clicking "Sync now": the manual sync route enqueues
-- with no job id on the default 60/min mutation tier.
--
-- Two nullable columns, no default, no backfill: NULL means "not locked", which
-- is the correct reading for every existing row. Additive and safe to deploy
-- ahead of the app — old containers ignore the columns and simply do not lock,
-- which is exactly today's behaviour.
--
-- Rollback: DROP COLUMN both. The lock degrades to absent, restoring the
-- pre-migration behaviour precisely.

ALTER TABLE "IntegrationConnection"
    ADD COLUMN "syncLockedAt" TIMESTAMP(3),
    ADD COLUMN "syncLockToken" TEXT;
