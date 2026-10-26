-- Legacy access recertification — population coverage on a snapshot (#3325).
--
-- A COMPLETE snapshot says our read was whole. It cannot say the far end handed
-- us the whole application: the operator's shim runs the query, the manifest's
-- rowCount is the shim's own claim, and a shim that can see one of twelve
-- workstations produces a manifest indistinguishable from one that saw them all.
-- So the population claim is a SEPARATE fact, and this is where it lives.
--
-- THE DEFAULT IS THE DECISION (owner decision, 2026-10-09). UNKNOWN is set here,
-- at the schema level, and the pull does not name the column. A column that
-- defaulted to a full-population claim with every present caller overriding it
-- would be one new transport away from regressing silently. Every existing row
-- takes UNKNOWN too, and that is accurate rather than conservative: no code path
-- has ever been able to observe a whole table, so no stored snapshot was ever
-- verified.
--
-- Additive and forward-only. A NEW type, so `CREATE TYPE` rather than
-- `ADD VALUE`, and the enum-isolation hazard does not arise. `NOT NULL` with a
-- constant DEFAULT is a catalogue-only change on Postgres 11+, so the table is
-- not rewritten. Still-running old containers never select or write the column,
-- and their inserts take the default.

-- CreateEnum
CREATE TYPE "LegacyAccessPopulationCoverage" AS ENUM ('UNKNOWN', 'VERIFIED');

-- AlterTable
ALTER TABLE "LegacyAccessSnapshot"
    ADD COLUMN "populationCoverage" "LegacyAccessPopulationCoverage" NOT NULL DEFAULT 'UNKNOWN';
