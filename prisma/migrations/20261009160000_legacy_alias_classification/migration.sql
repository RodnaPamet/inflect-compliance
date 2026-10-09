-- Step 4b part 2: a reviewer's decision is not always an employee link.
--
-- Three of the six reviewer actions the step specifies — NON_PERSON, EXTERNAL
-- and ORPHAN — classify the ACCOUNT rather than link it to a person, and
-- `LegacyIdentityAlias.employeeId` was NOT NULL, so none of them could be
-- stored at all.
--
-- ONE TABLE, NOT TWO. The alternative was a sibling `LegacyAccountClassification`
-- table, and it was rejected on the uniqueness: `@@unique([connectionId,
-- accountKey])` is what makes the alias "the one durable answer for this
-- account". Two tables permit an account to be aliased to a person AND marked
-- NON_PERSON at the same time, which would make the strongest signal in the
-- system ambiguous — the exact failure the model's own docblock warns about.
-- It also turns a reviewer changing their mind into a cross-table move rather
-- than an UPDATE.
--
-- The cost is that `employeeId` becomes nullable, giving up a database-level
-- guarantee for the EMPLOYEE case. That guarantee is reinstated below as a
-- CHECK constraint rather than traded for a comment, following
-- `Tenant_previousEncryptedDek_differs` from 20260424010000.
--
-- Prisma's `migrate diff` does not see CHECK constraints. That is why neither
-- that constraint nor this one appears in
-- `prisma/fresh-db-schema-drift.expected.sql`, whose three permanent groups are
-- DROP NOT NULL, pg_trgm GIN indexes and column-scoped SET NULL FKs. Nothing
-- here needs adding to that file, and adding it would fail the gate in the
-- other direction.

-- 1) The classification. EMPLOYEE first so the enum's natural order matches the
--    common case, and so a default of EMPLOYEE is the first member rather than
--    an arbitrary one.
CREATE TYPE "LegacyAliasClassification" AS ENUM ('EMPLOYEE', 'NON_PERSON', 'EXTERNAL', 'ORPHAN');

-- 2) A reviewer who picks the employee themselves. APPENDED: Postgres
--    `ADD VALUE` appends, and `enum-member-order-matches-migrations` compares
--    the schema's member order against the order the migrations produce.
--
--    `IF NOT EXISTS` is NOT decoration. Postgres commits an enum addition in a
--    way that does not roll back with the surrounding transaction, and Prisma
--    wraps a migration in one — so if any statement below fails, 'MANUAL' is
--    already permanent while the rest is not. A re-run of a BARE `ADD VALUE`
--    against an enum that already contains the value then FAILS, which is how
--    `20260920120000_agent_proposal_run_provenance` put production into a
--    restart loop for ~25 hours (#2745/#2746): `migrate deploy` runs on every
--    container start, P3009 refuses to proceed, the container exits, Docker
--    restarts it.
--
--    Enforced by tests/guardrails/migration-enum-isolation.test.ts, which is
--    the detector for that exact shape.
ALTER TYPE "LegacyMatchMethod" ADD VALUE IF NOT EXISTS 'MANUAL';

-- 3) The columns.
ALTER TABLE "LegacyIdentityAlias"
    ALTER COLUMN "employeeId" DROP NOT NULL,
    ADD COLUMN "classification" "LegacyAliasClassification" NOT NULL DEFAULT 'EMPLOYEE';

-- 4) The shape constraint — the guarantee DROP NOT NULL gave up.
--
-- Both directions, deliberately. "EMPLOYEE implies an employeeId" alone would
-- still admit an ORPHAN row carrying one, which is a row claiming the account
-- belongs to a person AND that nobody can say whose it is. A reader resolving
-- that contradiction has to guess, and the guess decides whether somebody keeps
-- access.
--
-- NON_PERSON's required owner and EXTERNAL's required expiry are NOT here, and
-- their COLUMNS are not in this migration either. They arrive with the reviewer
-- actions that write them.
--
-- That ordering was not a preference — two guards insisted on it.
-- `sanitize-rich-text-coverage` requires every encrypted-content model to name
-- the usecase that sanitises it, and `calendar-projection-completeness`
-- requires every deadline column to be projected or excluded with a reason.
-- Both were red with the columns present and no writer, which is the correct
-- answer: a column whose writer does not exist is a field nothing sanitises and
-- a deadline nothing surfaces.
ALTER TABLE "LegacyIdentityAlias"
    ADD CONSTRAINT "LegacyIdentityAlias_classification_shape"
    CHECK (
        ("classification" = 'EMPLOYEE' AND "employeeId" IS NOT NULL)
        OR ("classification" <> 'EMPLOYEE' AND "employeeId" IS NULL)
    );
