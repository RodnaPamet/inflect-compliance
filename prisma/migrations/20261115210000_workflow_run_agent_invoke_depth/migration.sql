-- THE INVOKE_AGENT RECURSION DEPTH A RUN WAS STARTED AT (#5716).
--
-- `MAX_AGENT_INVOKE_DEPTH` (5) was read off the job payload by
-- `agent-invoke-dispatch`, and nothing ever wrote the number it read. A run did
-- not record its depth, so the automation events its effects caused carried
-- none, so every invoke arrived at depth 1 and the `depth_exceeded` refusal
-- could not trip through a real cycle. This column is the half that was
-- missing: the run carries its depth, the bus stamps it onto every event the
-- run's effects cause, and `invokeAgent` enqueues one higher.
--
-- NO BACKFILL, on purpose. NULL means "no rule invoked this run, or the row
-- predates the column" — the three-state convention `mountedSkills` and
-- `policyCardVersion` already use on this table. A backfilled 1 would claim
-- every historical run was invoked at depth 1, which is a fact about none of
-- them.
ALTER TABLE "WorkflowRun" ADD COLUMN "agentInvokeDepth" INTEGER;

-- A depth is 1 or more: 1 is the first invoke, and the dispatcher increments
-- from whatever the triggering event carried. 0 would be a lap nobody took.
ALTER TABLE "WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_agentInvokeDepth_at_least_one"
    CHECK ("agentInvokeDepth" IS NULL OR "agentInvokeDepth" >= 1);

-- WRITE-ONCE for every role, the way the profile pin and `mountedSkills` are.
-- The depth is resolved before the row exists, so a later write could only be a
-- reconstruction — and this column is a RECURSION BOUND, so a row that could be
-- rewritten could be reset to 1 on every lap and the cap would stop binding.
-- Raised at the default SQLSTATE (P0001) so Prisma passes the message through.
CREATE OR REPLACE FUNCTION workflow_run_agent_invoke_depth_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."agentInvokeDepth" IS DISTINCT FROM OLD."agentInvokeDepth" THEN
        RAISE EXCEPTION
            'IMMUTABLE_AGENT_INVOKE_DEPTH: WorkflowRun.agentInvokeDepth is '
            'written once, when the run is created. It is the counter an '
            'agent-to-rule-to-agent cycle is bounded by; a depth that could be '
            'rewritten could be reset, and MAX_AGENT_INVOKE_DEPTH would stop '
            'binding.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_agent_invoke_depth_immutable ON "WorkflowRun";
CREATE TRIGGER workflow_run_agent_invoke_depth_immutable
    BEFORE UPDATE ON "WorkflowRun"
    FOR EACH ROW EXECUTE FUNCTION workflow_run_agent_invoke_depth_immutable_guard();
