-- The Art 14 stamp's lookup key.
--
-- `recordDecisionOutcomeForDigest` updates by (tenantId, inputDigest) filtered
-- on humanOutcome = 'PENDING'. AiDecisionLog gains a row per AI-feature
-- invocation, so without this the stamp degrades to a scan of everything the
-- tenant has ever generated — on the path a human reviewer is waiting on.
--
-- CONCURRENTLY is deliberately NOT used: Prisma wraps a migration in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. The table is
-- append-only and the write is a single insert per AI call, so the brief
-- exclusive lock a plain CREATE INDEX takes is acceptable here.
CREATE INDEX "AiDecisionLog_tenantId_inputDigest_idx"
  ON "AiDecisionLog"("tenantId", "inputDigest");
