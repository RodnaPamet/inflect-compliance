-- Web Bot Auth Phase 0.4 — the vendor monitor's TLS-grade refusals made
-- visible. Every fetch that did not grade used to be a null grade the sweep
-- read as "nothing observed", so a site refusing the monitor kept its old
-- grade and tlsCheckedAt with no trace. These two columns record what the
-- latest fetch came to and when.
--
-- Nullable with no default, so each ADD COLUMN is a catalogue-only change (no
-- table rewrite) and every existing row reads NULL: "has not fetched since the
-- column was added", which the UI does not call stale. No backfill — there is
-- no outcome to backfill from.
--
-- VendorMonitor already carries tenant_isolation + superuser_bypass with FORCE
-- ROW LEVEL SECURITY; row-level policies cover new columns without change.
ALTER TABLE "VendorMonitor" ADD COLUMN "tlsFetchOutcome" TEXT;
ALTER TABLE "VendorMonitor" ADD COLUMN "tlsFetchOutcomeAt" TIMESTAMP(3);

-- The vocabulary is `TLS_FETCH_OUTCOMES` in
-- src/app-layer/services/vendor-monitoring/types.ts. A TEXT column with a
-- CHECK rather than a Postgres enum: a new outcome is one migration widening
-- this CHECK, never a two-deploy enum value that an older Prisma client fails
-- to read. Both CHECKs hold trivially on the NULL rows, so they are added
-- validated.
ALTER TABLE "VendorMonitor" ADD CONSTRAINT "VendorMonitor_tlsFetchOutcome_known"
    CHECK ("tlsFetchOutcome" IS NULL OR "tlsFetchOutcome" IN ('GRADED', 'REFUSED', 'UNREACHABLE', 'BLOCKED'));

-- An outcome is always written with its time, and neither without the other.
ALTER TABLE "VendorMonitor" ADD CONSTRAINT "VendorMonitor_tlsFetchOutcome_paired"
    CHECK (("tlsFetchOutcome" IS NULL) = ("tlsFetchOutcomeAt" IS NULL));
