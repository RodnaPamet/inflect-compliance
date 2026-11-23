-- AgentProfileProvision.environmentHash (#5854, finding 7 of the Step 5H
-- adversarial read in docs/implementation-notes/2026-11-23-step-5h-adversarial-read.md).
--
-- The hash of the environment's configuration as Inflect wrote it, so a run
-- can re-read the environment before each session and refuse one that was
-- edited in the Anthropic Console (ENVIRONMENT_DRIFTED), as it already does
-- for the agent.
--
-- ADDITIVE ONLY: a nullable column and a CHECK on its shape. No enum changes,
-- no backfill. NULL means "not recorded" (a row written before this column);
-- the first run of such a row records the hash, then compares. Old containers
-- never select the column, so a rolling deploy is safe in both directions.

-- AlterTable
ALTER TABLE "AgentProfileProvision" ADD COLUMN "environmentHash" TEXT;

ALTER TABLE "AgentProfileProvision" ADD CONSTRAINT "AgentProfileProvision_environment_hash_shape"
    CHECK ("environmentHash" IS NULL OR "environmentHash" ~ '^[0-9a-f]{64}$');
