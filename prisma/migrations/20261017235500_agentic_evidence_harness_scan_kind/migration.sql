-- #3687 — the agentic evidence ledger learns a third kind: AGENT_HARNESS_SCANS.
--
-- A month of verified harness scans becomes one artefact per target control
-- (OWASP ASI10 and ASI03), through the same `(tenant, control, kind, period)`
-- identity the two existing kinds use. See `src/lib/agentic/evidence-artefact.ts`.
--
-- FORWARD-ONLY, ADDITIVE. `kind` is TEXT + CHECK precisely so that widening the
-- vocabulary is a CHECK swap and not an `ALTER TYPE` (see 20260906150000, whose
-- header gives the rolling-deploy reason). The constraint keeps its NAME, so
-- nothing else that names it changes. The two statements run in one migration
-- script, which Postgres executes as one implicit transaction: there is no
-- instant at which the column carries no CHECK. Re-adding the constraint
-- re-validates the existing rows, every one of which holds one of the two older
-- values, so the new set is a strict superset of what is stored.
--
-- ROLLING-DEPLOY SAFETY. A container built before this migration never writes
-- the new value, and its withdrawal sweep skips any kind its build does not know
-- (`withdrawalReasonFor`), so it neither fails on the new rows nor withdraws
-- them. A container built after it that runs before it is applied hits a check
-- violation on its first harness write; the job counts that tenant as skipped
-- and the next daily tick retries.
--
-- THE PLANNED-STATUS COLUMN. A harness artefact's Evidence status is a claim
-- about completeness, and the emitter has to tell its own verdict from a
-- person's review decision on the same column: it overrides a person only to
-- DEMOTE an incomplete month that reads APPROVED, and it promotes only a
-- NEEDS_REVIEW it set itself. `plannedEvidenceStatus` is the verdict it last
-- wrote down. Nullable with no default, so the ADD is a catalogue-only change
-- with no table rewrite; it reuses the existing "EvidenceStatus" type, so no
-- `ALTER TYPE` either. An older container neither selects nor writes it.
--
-- ROLLBACK. Redeploy the prior image; the migration stays. Narrowing the CHECK
-- again would fail as soon as one harness artefact exists, and the artefacts are
-- evidence that is withdrawn, never deleted — so this is forward-fix only.
ALTER TABLE "AgenticEvidenceArtefact" DROP CONSTRAINT IF EXISTS "AgenticEvidenceArtefact_kind_known";

ALTER TABLE "AgenticEvidenceArtefact"
    ADD CONSTRAINT "AgenticEvidenceArtefact_kind_known"
    CHECK ("kind" IN ('AGENT_ACTION_RECEIPTS', 'AI_DECISION_RECORDS', 'AGENT_HARNESS_SCANS'));

ALTER TABLE "AgenticEvidenceArtefact" ADD COLUMN "plannedEvidenceStatus" "EvidenceStatus";
