-- Framework.retiredAt — the product has stopped offering a framework.
--
-- Distinct from FrameworkRequirement.deprecatedAt, which means the grounding
-- library dropped a requirement. This one is a product decision: we will not
-- ship a catalogue we cannot author, and ISO 9001, ISO 39001 and ISO 28000 have
-- no library under src/data/libraries to author from.
--
-- The rows are RETIRED rather than DELETED. applyCatalogFile has no delete arm,
-- so removing a fixture from the seeder leaves its rows in every database that
-- already ran it; and a tenant who had installed one would lose its control
-- links if the rows vanished. Zero controls reference these three today
-- (measured in production 2026-09-19), so nothing breaks either way — the flag
-- is what makes the decision reversible and legible.
ALTER TABLE "Framework" ADD COLUMN "retiredAt" TIMESTAMP(3);

-- Partial index: every catalogue read filters `retiredAt IS NULL`, and that is
-- the overwhelmingly common row.
CREATE INDEX "Framework_retiredAt_idx" ON "Framework" ("retiredAt") WHERE "retiredAt" IS NOT NULL;

UPDATE "Framework"
   SET "retiredAt" = NOW()
 WHERE "key" IN ('ISO9001', 'ISO39001', 'ISO28000')
   AND "retiredAt" IS NULL;
