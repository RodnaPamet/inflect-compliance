-- Per-step evidence on the run timeline.
--
-- All three are NULLABLE with no backfill, deliberately. Every existing row
-- was recorded by the static driver, which guards nothing per step and reports
-- no per-step usage, so there is no value that would be true of them. A
-- default of CLEAN would assert the guard ran on rows it never touched, which
-- is the one reading an assessor must not be given.
--
-- `guardRuleIds` takes `[]` rather than NULL because an array column's empty
-- state is already "no rules fired"; a nullable array would add a third state
-- that means the same thing.
ALTER TABLE "WorkflowStep" ADD COLUMN "guardVerdict" "AgentGuardVerdict";
ALTER TABLE "WorkflowStep" ADD COLUMN "guardRuleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "WorkflowStep" ADD COLUMN "costTokens" INTEGER;
