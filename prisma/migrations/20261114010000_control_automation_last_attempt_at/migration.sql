-- #5204 — the automation runner backs off a control whose check cannot run.
--
-- `Control.nextDueAt` means "when the next REAL observation is due", and
-- `runScheduledAutomations` advances it only on PASSED/FAILED. That is
-- deliberate and correct: an ERROR (broken collector, expired credentials,
-- provider outage) or a NOT_APPLICABLE (empty population) must not stamp the
-- control as freshly tested, because that is an assurance an auditor could act
-- on. The automation-runner docblock argues it at length.
--
-- What nobody closed is the consequence. A control whose check can NEVER
-- succeed keeps `nextDueAt` in the past for ever, and:
--
--   • `findDueAutomationControls` orders by `nextDueAt ASC`, so the oldest
--     stuck controls sort FIRST;
--   • its dedupe counts only PASSED/FAILED/RUNNING executions, and FOUR of the
--     runner's failure paths return before writing any execution row at all
--     (invalid automationKey, no provider for the key, provider does not
--     support scheduled checks, no connection), so nothing dedupes them;
--   • the batch is bounded at 500.
--
-- So once 500 such controls exist fleet-wide they fill every batch, no other
-- control is ever checked — including every control with a NULL `nextDueAt`,
-- which sorts LAST under ASC despite the query's comment calling it "execute
-- immediately" — and a throwing provider is called again on every 15-minute
-- tick, writing a fresh ERROR row each time.
--
-- This column is the backoff, and it is deliberately NOT `nextDueAt`: the two
-- answer different questions. `nextDueAt` is when an observation is due;
-- `automationLastAttemptAt` is when we last TRIED, whatever came back. The
-- runner stamps it for every control in the batch, including the ones it skips
-- for having no registered provider, and the due query then treats a control
-- attempted within its own frequency window exactly as it treats a recent
-- verdict: not due.
--
-- SAFE TO ADD: a nullable column with no default is a catalogue-only change in
-- PostgreSQL 11+ — no table rewrite, no scan, no lengthy lock. NULL is the
-- right value for every existing row: never attempted, so due on the first
-- tick after deploy, exactly as today. No backfill.
--
-- No index. The due query's selective terms are `automationKey IS NOT NULL`,
-- `evidenceSource = 'INTEGRATION'` and the `nextDueAt` window, and the backoff
-- is applied in the per-control filter the query already runs over a batch
-- bounded at 500. A fifth index on `Control` would cost every control write to
-- save nothing measurable on a 500-row ceiling.
--
-- FORWARD-ONLY.

ALTER TABLE "Control" ADD COLUMN "automationLastAttemptAt" TIMESTAMP(3);

-- POST-CONDITION: nullable, no default — both load-bearing above.
DO $$
DECLARE
    nullable TEXT;
    dflt     TEXT;
BEGIN
    SELECT is_nullable, column_default INTO nullable, dflt
    FROM information_schema.columns
    WHERE table_name = 'Control' AND column_name = 'automationLastAttemptAt';

    IF nullable IS NULL THEN
        RAISE EXCEPTION '#5204: Control."automationLastAttemptAt" is missing after this migration';
    END IF;
    IF nullable <> 'YES' THEN
        RAISE EXCEPTION '#5204: Control."automationLastAttemptAt" must be nullable — NULL means never attempted';
    END IF;
    IF dflt IS NOT NULL THEN
        RAISE EXCEPTION '#5204: Control."automationLastAttemptAt" must have no default, found %', dflt;
    END IF;
END $$;
