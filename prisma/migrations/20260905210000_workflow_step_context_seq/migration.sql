-- The replay anchor for the workflow context chain.
--
-- Additive and nullable: no backfill, because a step recorded before this
-- column existed genuinely does not know its chain position, and inventing one
-- would be worse evidence than none. A run whose ledger is entirely NULL simply
-- has no lower bound to check against — the same posture the chain already
-- takes for a pre-integrity row.
ALTER TABLE "WorkflowStep" ADD COLUMN "contextSeq" INTEGER;
