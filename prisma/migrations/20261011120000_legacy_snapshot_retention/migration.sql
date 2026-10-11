-- #3317 — legacy access snapshots get a TTL.
--
-- `LegacyAccessSnapshot` rows and their `LegacyAccount` children were retained
-- INDEFINITELY. The accounts are DSAR-relevant PII — email, display name, given
-- and family names, username, employee number, department, title, manager
-- reference — for identified people in a customer's legacy application, and the
-- snapshot is deliberately immutable, so a connection pulled daily accumulated
-- everybody's access forever. `docs/data-retention.md` carried that as open
-- question 9 with "retain indefinitely" as the default until decided.
--
-- Owner decision: a TTL sweep with a 90-day default, tenant-settable.
--
-- TWO COLUMNS, NOT ONE, and the second is the point of the issue:
--
--   legacySnapshotRetentionDays            90   after the run that CONSUMED it
--   legacySnapshotUnconsumedRetentionDays  30   when nothing ever consumed it
--
-- An unconsumed snapshot must still age out, or a connection that pulls and
-- never reconciles keeps named people indefinitely — which is the exact case
-- filed. It gets a shorter bound because no recertification artefact cites it,
-- so deleting it costs a re-pull rather than evidence.
--
-- DEFAULTS ONLY, NO BACKFILL AND NO SWEEP HERE. Adding a column with a default
-- is what this migration does; deciding which rows to destroy is a job, run on
-- a schedule, auditable, and dry-runnable. A migration that deleted customer
-- data as a side effect of a schema change would be unreviewable.
ALTER TABLE "TenantSecuritySettings"
    ADD COLUMN "legacySnapshotRetentionDays" INTEGER NOT NULL DEFAULT 90,
    ADD COLUMN "legacySnapshotUnconsumedRetentionDays" INTEGER NOT NULL DEFAULT 30;

-- And the index the sweep's unconsumed arm needs.
--
-- It filters `tenantId` + `pulledAt < cutoff` with NO connection and no status —
-- a retention sweep is not per-connection. The existing
-- `[tenantId, connectionId, status, pulledAt]` cannot serve that: `pulledAt` is
-- the FOURTH column, so with the middle two absent from the predicate only the
-- `tenantId` prefix is usable and the scan is tenant-wide. Adding it is
-- `schema-index-coverage` Layer C's prescribed triage for a filter on a
-- non-leading column, rather than an argument that the scan is small enough.
CREATE INDEX IF NOT EXISTS "LegacyAccessSnapshot_tenantId_pulledAt_idx"
    ON "LegacyAccessSnapshot" ("tenantId", "pulledAt");
