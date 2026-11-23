-- WorkflowRun lease (#5854, finding 2 of the Step 5H adversarial read in
-- docs/implementation-notes/2026-11-23-step-5h-adversarial-read.md).
--
-- A BullMQ job that executes a run can be delivered twice: a stalled-job
-- redelivery, or a retry while the first attempt still runs. Nothing on the
-- row said a worker was already executing it, so two workers drove one run at
-- the same time. The worker now claims the run before it executes: a
-- conditional UPDATE that sets `leaseHolder` (an attempt token) and
-- `leaseExpiresAt` only where nobody holds the run or the lease has lapsed,
-- and it renews the lease while it runs. Every write the engine makes is then
-- conditional on the token, so a worker that lost the run writes nothing more.
-- See src/lib/agentic/run-lease.ts and
-- docs/implementation-notes/2026-11-23-fix-5854-run-claim.md.
--
-- ADDITIVE ONLY: two nullable columns and a CHECK that keeps them together.
-- No enum change, no backfill. NULL is "nobody holds this run", which is the
-- truth for every existing row. Old containers never select either column, so
-- a rolling deploy is safe in both directions; a run an old worker executes is
-- simply unclaimed, as every run was before.

-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "leaseHolder" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- A holder always has an expiry, and an expiry always has a holder: a lease
-- with no expiry could never be taken over, and an expiry with no holder means
-- nothing.
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_lease_pair"
    CHECK (("leaseHolder" IS NULL) = ("leaseExpiresAt" IS NULL));
