-- #5256 — a dispatch pass CLAIMS an external-write row before it sends it.
--
-- `runExternalWriteDispatch` read `findMany({ where: { tenantId, outcome:
-- 'PENDING' } })`, ran its checks, called the far end's write tool, and only
-- THEN called `settleWrite` — which is the first write conditioned on
-- `outcome: 'PENDING'`. Nothing marked the row in flight in between, and the
-- job is a `*/10` repeatable on a worker with `concurrency: 5`.
--
-- Two ways the same approved write was applied twice:
--
--   1. A pass covering many tenants runs past ten minutes (slow prior-state
--      reads and sends). The next scheduled pass starts on another worker
--      slot, reads the same PENDING rows, and both call the write tool.
--   2. The worker crashes, or `settleWrite`'s own DB call fails, AFTER
--      `callTool` succeeded. The row stays PENDING and the next pass sends it
--      again.
--
-- Either way an access grant, a revoke or a service-principal disable lands
-- twice while the journal records one attempt. The job's own comment — "the
-- row stays PENDING and the next pass retries it, which is safe precisely
-- because nothing was sent" — stops being true the moment `callTool` has
-- returned.
--
-- This column is the claim. The pass stamps it with an `updateMany`
-- conditioned on `outcome: 'PENDING' AND "claimedAt" IS NULL`, which exactly
-- one pass wins; the loser skips the row. A claimed row still PENDING after
-- the pass's staleness window is settled INDETERMINATE and never re-sent,
-- because nobody can claim the far end is unchanged (owner decision,
-- 2026-11-13: 60 minutes, comfortably longer than any plausible pass, so a
-- slow-but-live pass is not robbed of its row).
--
-- SAFE TO ADD: a nullable column with no default is a catalogue-only change in
-- PostgreSQL 11+ — no table rewrite, no scan, no lengthy lock, so it cannot
-- time out a rolling deploy. NULL is the correct value for every existing row:
-- unclaimed, and therefore claimable.
--
-- No index. The pass's selective terms are `tenantId` and `outcome`, already
-- served by `@@index([tenantId, outcome])`, and `claimedAt IS NULL` is a cheap
-- residual over a batch bounded at DISPATCH_BATCH_LIMIT. A fourth index on this
-- table would cost every journal write to save nothing measurable.
--
-- FORWARD-ONLY.

ALTER TABLE "ExternalWriteJournal" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- POST-CONDITION: the column exists, is nullable, and has no default.
DO $$
DECLARE
    nullable TEXT;
    dflt     TEXT;
BEGIN
    SELECT is_nullable, column_default INTO nullable, dflt
    FROM information_schema.columns
    WHERE table_name = 'ExternalWriteJournal' AND column_name = 'claimedAt';

    IF nullable IS NULL THEN
        RAISE EXCEPTION '#5256: ExternalWriteJournal."claimedAt" is missing after this migration';
    END IF;
    IF nullable <> 'YES' THEN
        RAISE EXCEPTION '#5256: ExternalWriteJournal."claimedAt" must be nullable; existing rows are unclaimed';
    END IF;
    IF dflt IS NOT NULL THEN
        RAISE EXCEPTION '#5256: ExternalWriteJournal."claimedAt" must have no default, found %', dflt;
    END IF;
END $$;
