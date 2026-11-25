-- Active flavour, step 8c — the agentic evidence ledger learns PROBE_RUNS.
--
-- A month of verified probe runs (`scanent-probes/1`, ingested by
-- `usecases/probe-runs.ts`) becomes one artefact per target control — OWASP
-- Agentic ASI01 and ASI02, ISO 27001 A.8.29 and SOC 2 CC4.1 — through the same
-- `(tenant, control, kind, period, agent)` identity every kind uses. It is a
-- tenant-wide kind: `agentId` stays NULL, so `AgenticEvidenceArtefact_agent_scope`
-- needs no change. See `src/lib/agentic/evidence-artefact.ts`.
--
-- FORWARD-ONLY, ADDITIVE. `kind` is TEXT + CHECK so that widening the vocabulary
-- is a CHECK swap and not an `ALTER TYPE` (20260906150000 gives the rolling-deploy
-- reason). The constraint keeps its NAME. Both statements run in one migration
-- script, one implicit transaction, so there is no instant at which the column
-- carries no CHECK. Re-adding it re-validates the stored rows, every one of which
-- holds one of the six older values, so the new set is a strict superset.
--
-- ROLLING-DEPLOY SAFETY. A container built before this migration never writes the
-- new value, and its withdrawal sweep skips a kind its build does not know
-- (`withdrawalReasonFor`), so it neither fails on the new rows nor withdraws them.
-- A container built after it that runs before it is applied hits a check
-- violation on its first probe-runs write; the job counts that tenant as skipped
-- and the next daily tick retries.
--
-- ROLLBACK. Redeploy the prior image; the migration stays. Narrowing the CHECK
-- again would fail as soon as one probe-runs artefact exists, and the artefacts
-- are evidence that is withdrawn, never deleted — so this is forward-fix only.

ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT IF EXISTS "AgenticEvidenceArtefact_kind_known";
ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"
    CHECK ("kind" IN (
        'AGENT_ACTION_RECEIPTS',
        'AI_DECISION_RECORDS',
        'AGENT_HARNESS_SCANS',
        'INTEGRATION_PASSPORTS',
        'AGENT_ACTION_RECEIPTS_PER_AGENT',
        'AI_DECISION_RECORDS_PER_AGENT',
        'PROBE_RUNS'
    ));
