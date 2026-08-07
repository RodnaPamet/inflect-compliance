-- Drop two columns that no code reads or writes.
--
-- Control.reviewCadence
--   Present since init (20260308190244), five months. ZERO reads and ZERO
--   writes across all of src/ — every `reviewCadence` hit in the repo is
--   RiskAppetiteConfig.reviewCadence, a different model in risk.prisma.
--   The `ReviewCadence` enum stays: RiskAppetiteConfig still uses it.
--
-- ControlTemplate.defaultOwnerHint
--   Populated by four framework fixture files and prisma/seed.ts, and read
--   by NO install path, repository, DTO or component. Data went in and
--   never came out.
--
-- Both are irreversible in the sense that the stored values are discarded,
-- which is the point: they were never read, so nothing can miss them. A
-- forward-fix (re-adding the column) is a one-line migration if either is
-- ever wanted for real.

ALTER TABLE "Control" DROP COLUMN IF EXISTS "reviewCadence";
ALTER TABLE "ControlTemplate" DROP COLUMN IF EXISTS "defaultOwnerHint";
