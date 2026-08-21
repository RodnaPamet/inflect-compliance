-- #120 — split the scan ATTEMPT record from the scan VERDICT.
--
-- `scanStatus` / `scanDetails` / `scannedAt` record what a scanner decided.
-- They are terminal and rare, and the rescan sweep must never fabricate one.
-- The three columns below record only that we tried, so a row that can never
-- reach a verdict (object missing from storage, bytes no longer matching
-- `sha256`, a payload clamd cannot parse) stops being re-selected at full
-- cadence by every bounded, oldest-first sweep and starving the rows behind
-- it.
--
-- All three are additive and nullable-or-defaulted, so an old container in a
-- rolling deploy keeps working unchanged: it never reads or writes them, and
-- `nextScanAttemptAt IS NULL` reads as "due now" to the new code.
ALTER TABLE "FileRecord"
    ADD COLUMN "scanAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastScanAttemptAt" TIMESTAMP(3),
    ADD COLUMN "nextScanAttemptAt" TIMESTAMP(3);

-- Backs the sweep's selection predicate (tenant + PENDING + due-now).
CREATE INDEX "FileRecord_tenantId_scanStatus_nextScanAttemptAt_idx"
    ON "FileRecord" ("tenantId", "scanStatus", "nextScanAttemptAt");
