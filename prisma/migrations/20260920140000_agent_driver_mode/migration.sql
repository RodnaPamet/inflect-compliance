-- The customer's half of the agent DRIVER gate.
--
-- Hand-written for the same reason as
-- 20260920120000_agent_proposal_run_provenance: a full `migrate diff` against
-- this directory carries 271 lines of pre-existing drift (constraint drop/
-- re-add pairs under identical names, three emailHash nullability changes, a
-- DROP INDEX on a trigram index) that has nothing to do with this change.

-- CreateEnum
CREATE TYPE "AgentDriverMode" AS ENUM ('STATIC', 'FLUE');

-- AlterTable
--
-- NOT NULL with a DEFAULT, unlike most columns added to populated tables here.
-- It is safe because the default is the FAIL-CLOSED value: every existing row
-- backfills to STATIC, which is the behaviour every tenant already has, so the
-- ALTER changes no observable behaviour for anyone.
--
-- Choosing NOT NULL over nullable is the point. A nullable column would add a
-- third state that every reader would have to map, and the identity ladder's
-- `PROPOSE` rung records what happens when an unmapped state reaches a
-- comparison: unknown sorts below the clamp, i.e. cleared to run, i.e. fails
-- PERMISSIVE. Here the reader coerces anyway (`coerceStoredDriverMode`), but
-- the column should not be manufacturing a state for it to coerce.
ALTER TABLE "TenantSecuritySettings"
  ADD COLUMN "agentDriver" "AgentDriverMode" NOT NULL DEFAULT 'STATIC';
