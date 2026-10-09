-- Step 4b: the fields the reviewer actions write.
--
-- Deliberately NOT in 20261009160000, which added the classification. Two
-- guards made that split, and both were right:
--
--   `sanitize-rich-text-coverage` requires every encrypted-content model to
--   name the usecase that sanitises it. `justification` is free text a reviewer
--   typed about a named person.
--
--   `calendar-projection-completeness` requires every deadline column to be
--   projected into the calendar or excluded with a reason. `expiresAt` is a
--   deadline.
--
-- Neither question has an answer until the writer exists. A column whose writer
-- does not exist is a field nothing sanitises and a deadline nothing surfaces,
-- so the columns arrive here, with it.

ALTER TABLE "LegacyIdentityAlias"
    ADD COLUMN "ownerUserId" TEXT,
    ADD COLUMN "justification" TEXT,
    ADD COLUMN "expiresAt" TIMESTAMP(3);

-- The expiry sweep's own read. Without it, "which EXTERNAL aliases have
-- expired?" scans every alias the tenant holds, every cycle, per connection.
CREATE INDEX "LegacyIdentityAlias_tenantId_classification_expiresAt_idx"
    ON "LegacyIdentityAlias"("tenantId", "classification", "expiresAt");

-- NOTE ON WHAT IS *NOT* CONSTRAINED HERE.
--
-- NON_PERSON's owner and EXTERNAL's expiry are required by the usecase, not by
-- the database. That is not an oversight and it is not laziness:
-- `LegacyIdentityAlias_classification_shape` forbids rows that CONTRADICT
-- themselves, which is a permanent property of the data. These two are
-- COMPLETENESS, and completeness is exactly what a backfill or a repair script
-- legitimately fills in a second pass. A constraint forbidding the intermediate
-- state turns a recoverable migration into an impossible one.
--
-- The usecase enforces both, and `tests/integration/legacy-reviewer-actions`
-- proves each refusal.

-- The reviewer actions' own two reads on LegacyAccountResolution.
--
-- Registered in tests/guardrails/schema-index-coverage.test.ts, which is what
-- caught their absence: adding a findMany over a tenant model obliges you to
-- say which index serves it, and neither of these was covered. The version
-- check runs once per decision AND once per bulk row, so the unindexed form is
-- a table scan per click.
CREATE INDEX "LegacyAccountResolution_tenantId_accountKey_createdAt_idx"
    ON "LegacyAccountResolution"("tenantId", "accountKey", "createdAt");
CREATE INDEX "LegacyAccountResolution_tenantId_executionId_outcome_idx"
    ON "LegacyAccountResolution"("tenantId", "executionId", "outcome");
