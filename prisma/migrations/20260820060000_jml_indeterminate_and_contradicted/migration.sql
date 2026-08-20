-- Two fixes from an adversarial review of the disable primitive.

-- 1. A lost response is not a refusal.
--
-- Collapsing a timeout into FAILED is a positive claim that the directory is
-- unchanged. When the write actually landed, that claim makes the row invisible
-- to BOTH readers at once: findRestorableState filters APPLIED (so the captured
-- prior state is unreachable) and listUnsettledWrites filters PENDING (so no
-- human is told to look). Strictly worse than crashing, which correctly leaves
-- PENDING.
ALTER TYPE "IdentityWriteOutcome" ADD VALUE IF NOT EXISTS 'INDETERMINATE';

-- 2. A disproven link must leave the candidate set.
--
-- The reconciler already detects that an account's email now resolves to a
-- different worker and correctly refuses to re-point the link — but it left the
-- link in place with its old lastVerifiedAt, and that column is only ever set
-- to now(), never cleared. A positively disproven pairing therefore stayed
-- eligible for a leaver disable for the rest of its freshness window.
ALTER TABLE "IdentityAccountLink" ADD COLUMN "contradictedAt" TIMESTAMP(3);

-- The leaver candidate query filters on it, so it leads with tenantId.
CREATE INDEX "IdentityAccountLink_tenantId_contradictedAt_idx"
    ON "IdentityAccountLink"("tenantId", "contradictedAt");
