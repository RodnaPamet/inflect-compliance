# 2026-07-14 — Guided test run (R3-P2)

**Commit:** `<pending> feat(tests): guided test run — RUNNING flow, authorable steps, evidence picker`

## Design

"Running" a manual test used to mean: POST an empty `ControlTestRun`
(status `PLANNED`), land on the run page, and fill in a result form. The
`RUNNING` enum value was dead — never assigned. Steps existed in the data
model but no form authored them and no run showed them. This makes the run a
**guided execution** and closes five adjacent gaps.

### The run lifecycle (now three real states)

```
createTestRun → PLANNED ──startTestRun──▶ RUNNING ──completeTestRun──▶ COMPLETED
                  │                          │
             show procedure             walk the step checklist,
             + "Start test"             then record PASS/FAIL/INCONCLUSIVE
```

The run page renders per state: **PLANNED** shows the procedure preview +
a "Start test" CTA; **RUNNING** shows the steps as a live checklist plus the
result form; **COMPLETED** is read-only. The result form is gated on
`RUNNING`, so the UI enforces start-before-complete. (`completeTestRun` stays
permissive from `PLANNED` for backward compatibility with automated/API
callers.)

### method ↔ automationType — one reconciled model

`method` (auditor-facing MANUAL/AUTOMATED) and `automationType` (how execution
runs: MANUAL/SCRIPT/INTEGRATION) were edited on two surfaces and could
disagree. `deriveMethodFromAutomationType()` is now the single source of
truth, applied on every write:

- `scheduleTestPlan` sets `method = derive(automationType)` — a scheduled plan
  can never read as MANUAL.
- `updateTestPlan`, when `method` is set to MANUAL, strips automation
  (`automationType=MANUAL`, `schedule=null`, `nextRunAt=null`) so the
  scheduler can't keep firing a "manual" plan.

Frequency vs schedule are reconciled into one visible "next": `nextDueAt`
(the soft due-by the /tests + /tests/due views show) tracks `nextRunAt` for a
scheduled plan and falls back to the frequency-driven date when reverted to
MANUAL — no migration.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/control-test.ts` | `startTestRun` (PLANNED→RUNNING); `deriveMethodFromAutomationType`; `updateTestPlan` steps + method→MANUAL reconciliation |
| `src/app-layer/usecases/test-scheduling.ts` | `scheduleTestPlan` syncs `method` + `nextDueAt` into one model |
| `src/app-layer/repositories/TestRunRepository.ts` | `start()`; `getById` now includes the plan's steps |
| `src/app-layer/repositories/TestPlanRepository.ts` | `update` handles steps replacement + automation fields |
| `src/app/api/t/[tenantSlug]/tests/runs/[runId]/start/route.ts` | POST — begin a run |
| `src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx` | Guided run: Start / checklist / result; evidence Combobox; error toasts |
| `src/app/t/[tenantSlug]/(app)/tests/_components/TestStepsEditor.tsx` | Shared step-authoring editor (create modal + edit form) |
| `src/app/t/[tenantSlug]/(app)/tests/_components/NewTestPlanModal.tsx` | Steps editor wired into global create |
| `src/app/t/[tenantSlug]/(app)/controls/[controlId]/tests/[planId]/page.tsx` | Steps editor in edit form; save/run error toasts |
| `src/app/t/[tenantSlug]/(app)/tests/due/page.tsx` | Run-now uses `router.push` (was `window.location.href`) + error toast |
| `src/components/TestPlansPanel.tsx` | create/run error toasts |
| `src/lib/schemas/index.ts` | `UpdateTestPlanSchema` accepts `steps` |

## Decisions

- **RUNNING is UI-gated, not usecase-forced.** `completeTestRun` still accepts
  a PLANNED run so automated runs and API/SDK callers aren't broken; the
  guided flow is enforced in the run page (Start button reveals the result
  form). RUNNING is now a real, assigned, visible state.
- **Per-step check state is ephemeral.** The RUNNING checklist ticks are a
  client-side execution aid, not persisted — persisting per-step results would
  need a `ControlTestStepResult` model + migration; deferred.
- **method is derived, not independently editable.** One mapping helper, run on
  every write. No schema change — the reconciliation is write-layer only.
- **Steps replace-on-write.** `updateTestPlan({ steps })` deletes + recreates
  the plan's steps atomically inside the tenant transaction (empty array
  clears the procedure).
