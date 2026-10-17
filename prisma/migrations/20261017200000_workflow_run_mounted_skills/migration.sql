-- Step 1b of the agentic IAM roadmap (#3666) — PINNING the skills a run was taught.
--
-- A run mounts the skills its workflow definition declares, and a skill is a
-- document that can be edited. Without a pin, "what did this agent know when it
-- ran?" is answered by reading the skill as it is TODAY. This records, per run,
-- the name, version and SHA-256 of each mounted skill's instructions, so the
-- answer survives the next edit.
--
-- ─── THREE STATES IN ONE NULLABLE COLUMN ────────────────────────────
--
--   NULL   — the row predates the pin. Not backfilled: writing [] across old
--            rows would assert that they mounted nothing, which nobody checked.
--   []     — the pin was resolved and the run mounted no skill.
--   [...]  — what it mounted.
--
-- ─── WRITE-ONCE, STRICTER THAN THE POLICY-CARD PIN ──────────────────
--
-- `workflow_run_policy_card_pin_immutable` permits NULL → value, for a write
-- path that learns the card version late. This one permits nothing after the
-- INSERT: the skills are resolved before the row exists, so a later write could
-- only be a reconstruction, and a reconstructed pin is the thing a pin exists to
-- rule out. Enforced for every role by a trigger, for the reason the card pin's
-- migration gives: the table is updated constantly on the ordinary path, so a
-- privilege cannot separate this column from the rest of the row.
--
-- Raised at the default SQLSTATE (P0001), not 23001, so Prisma passes the
-- message through instead of reporting a foreign-key violation — the same choice
-- 20260905190000_agent_policy_card_pin documents.

ALTER TABLE "WorkflowRun" ADD COLUMN "mountedSkills" JSONB;

ALTER TABLE "WorkflowRun"
    ADD CONSTRAINT "WorkflowRun_mounted_skills_is_array"
    CHECK ("mountedSkills" IS NULL OR jsonb_typeof("mountedSkills") = 'array');

CREATE OR REPLACE FUNCTION workflow_run_mounted_skills_immutable_guard()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."mountedSkills" IS DISTINCT FROM OLD."mountedSkills" THEN
        RAISE EXCEPTION
            'IMMUTABLE_SKILL_PIN: WorkflowRun.mountedSkills is written once, when the '
            'run is created. It records what the run was taught; rewriting it would '
            'describe a different run.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_run_mounted_skills_immutable ON "WorkflowRun";
CREATE TRIGGER workflow_run_mounted_skills_immutable
    BEFORE UPDATE ON "WorkflowRun"
    FOR EACH ROW
    EXECUTE FUNCTION workflow_run_mounted_skills_immutable_guard();
