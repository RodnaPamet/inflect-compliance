-- #5259 — the reconcile passes rotate through their population.
--
-- The ACCEPTED-delivery reconcile and the grant-expiry sweep each read a
-- bounded batch, oldest first. Rows that can never progress (a deleted
-- connection, an unparseable end date, a grant already escalated) stayed at
-- the front, so every pass read the same rows and the ones behind them were
-- never checked. Both passes now stamp every row they visit and read the least
-- recently visited first.
--
-- Nullable and additive: a container that predates the column neither reads
-- nor writes it, so a rolling deploy is safe. NULL sorts first, so rows never
-- visited are read before any row already visited.
ALTER TABLE "ExternalWriteJournal" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);

CREATE INDEX "ExternalWriteJournal_tenantId_outcome_lastCheckedAt_idx"
    ON "ExternalWriteJournal" ("tenantId", "outcome", "lastCheckedAt");
