-- Agentic run provenance + the two driver step kinds.
--
-- HAND-WRITTEN rather than `prisma migrate dev` output, on purpose. A full
-- `migrate diff` against this migrations directory emits 39 DROP CONSTRAINT /
-- ADD CONSTRAINT pairs under IDENTICAL names, plus three `emailHash DROP NOT
-- NULL`s and a `DROP INDEX "Control_objective_trgm_idx"` — pre-existing drift
-- between the directory and the schema, none of it touching AgentProposal or
-- WorkflowRun. Shipping it would have hidden four intended statements inside
-- 275 lines of churn and dropped a trigram index nothing in this change knows
-- about. The four below are the generated statements for THIS diff, copied
-- verbatim; the CHECK is added by hand.

-- AlterEnum
-- Two values, one migration: safe on Postgres 12+ (this deployment is 16) so
-- long as neither value is USED in the same transaction, which nothing here
-- does.
--
-- The rolling-deploy hazard runs the other way from the `@@map("WorkItem*")`
-- pins, which guard ALTER TYPE ... RENAME. Adding a value is invisible to an
-- old container UNTIL a new one writes a row carrying it. Nothing writes these
-- until the `flue` driver is enabled, and that flag is off by default and fails
-- closed — so the window where an old container could read an unknown value
-- never opens during the deploy that adds them.
ALTER TYPE "WorkflowStepKind" ADD VALUE 'MODEL_CALL';
ALTER TYPE "WorkflowStepKind" ADD VALUE 'TOOL_CALL';

-- AlterTable
ALTER TABLE "AgentProposal" ADD COLUMN     "runId" TEXT,
ADD COLUMN     "stepSeq" INTEGER;

-- CreateIndex
CREATE INDEX "AgentProposal_tenantId_runId_idx" ON "AgentProposal"("tenantId", "runId");

-- AddForeignKey
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_runId_tenantId_fkey" FOREIGN KEY ("runId", "tenantId") REFERENCES "WorkflowRun"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A step ordinal naming no run addresses nothing. `WorkflowStep` is keyed
-- (runId, seq) as an INDEX and not a unique constraint — one step may record
-- several proposals — so Postgres has no unique target for a composite FK on
-- the pair. This CHECK is the half of that relationship that IS enforceable,
-- and it is the same shape as `AgentProposal_update_requires_target` above it:
-- a state the reviewer cannot resolve must not be storable.
ALTER TABLE "AgentProposal" ADD CONSTRAINT "AgentProposal_step_requires_run"
  CHECK ("stepSeq" IS NULL OR "runId" IS NOT NULL);
