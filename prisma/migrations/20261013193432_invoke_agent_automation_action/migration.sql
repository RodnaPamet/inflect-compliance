-- #3471 — INVOKE_AGENT as an automation action.
--
-- ADD VALUE IF NOT EXISTS, not a type rewrite. Renaming or recreating an enum
-- fails old containers mid-deploy with SQLSTATE 42704; adding a value is safe
-- while both the old and new code are serving, because nothing writes the new
-- value until the new code is live. Same shape as
-- `20260717120000_task_sourcing_correctness`.
ALTER TYPE "AutomationActionType" ADD VALUE IF NOT EXISTS 'INVOKE_AGENT';
