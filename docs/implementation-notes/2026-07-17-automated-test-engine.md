# 2026-07-17 — Automated control-test engine: honest scheduled runs + effectiveness parity + Checks-tab labeling (PR-P)

**Commit:** `<pending> feat(tests): honest scheduled runs (no INCONCLUSIVE no-op), automated-run effectiveness parity, verdict-only pass-rate, Checks-tab relabel (Prompt 1)`

## Design

The automated test pipeline was "a wired pipeline with no engine": the
`runnerHandlerRegistry` is empty (no SCRIPT/INTEGRATION handler is registered
anywhere in `src`), so every scheduled run hit the no-handler branch and
completed as an `INCONCLUSIVE` no-op — showing raw "no handler registered" text
as evidence, dragging the pass-rate down, and never stamping `lastTested`. Three
fixes, all under the theme "make the automated side honest".

### 1. No-engine scheduled runs → PLANNED "awaiting manual completion" (decision: **b**)

Rather than register a fake engine, a scheduled plan with no handler now produces
the same honest PLANNED "awaiting manual completion" run that `handleManualPlan`
already creates. The runner's `handleAutomatedPlan` delegates to
`handleManualPlan` when `runnerHandlerRegistry.get(type)` is empty. A no-engine
run never reaches `COMPLETED`, so it never enters the effectiveness denominator.

The honest data model that follows: **a scheduled plan is a MANUAL plan on a
cadence.** `TestPlanScheduleSection` no longer force-labels a cadence as
`SCRIPT`; it sets `MANUAL`. `scheduleTestPlan`'s invariant is relaxed so a MANUAL
plan MAY carry a cron (SCRIPT/INTEGRATION still require one). The scheduler's
`findDueTestPlans` drops the `automationType IN (SCRIPT, INTEGRATION)` filter —
any ACTIVE plan with a `schedule` is due-eligible, so scheduled MANUAL plans
(previously invisible to the scheduler) are enqueued and instantiate an awaiting
run each tick.

### Pass-rate excludes INCONCLUSIVE (decision: verdict-only denominator)

`computeControlEffectivenessMap` now computes `passRate = passes / scored` where
`scored = passes + fails`. INCONCLUSIVE runs (a handler error, a genuinely
undecidable manual run) stay in `total` (for display) but are excluded from the
denominator, so a no-verdict run can't silently drag measured effectiveness down.
An all-inconclusive window yields `passRate: null`, not a misleading `0%`.

### 2. Automated-run effectiveness parity

A registered handler's completion path now calls `attestControlTested` +
`TestPlanRepository.updateNextDueAt`, exactly as manual `completeTestRun` does —
one completion path, one set of side effects. Dormant until a real engine
registers, but wired so parity holds the moment one does. `attestControlTested`
was made `export`.

### 3. Integration checks relabeled, not force-fitted (decision: **B**)

`createAutomatedTestRun` requires a `planId`; an `IntegrationExecution` check is
keyed to a `Control` + `automationKey` with **no plan linkage**. Forcing checks
into plan runs would mean inventing a plan↔check coupling that doesn't exist.
Checks already stamp `Control.lastTested`/`nextDueAt` + reconcile findings — they
are control-scoped monitoring telemetry, deliberately separate from plan test
runs. The Checks tab is relabeled to say so explicitly (they do NOT count toward
the test-run pass-rate). `createAutomatedTestRun` stays the explicit plan-scoped
bridge, reachable via the `automation-run` route.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/control-test.ts` | Verdict-only pass-rate (`scored` field); `export attestControlTested` |
| `src/app-layer/jobs/control-test-runner.ts` | No-handler → `handleManualPlan`; handler-completion parity (attest + cadence); `frequency` in select |
| `src/app-layer/jobs/control-test-scheduler.ts` | `findDueTestPlans` no longer restricts by automationType |
| `src/app-layer/usecases/test-scheduling.ts` | MANUAL may carry a cron (invariant relaxed) |
| `src/components/TestPlanScheduleSection.tsx` | Cadence → `MANUAL` (stopped force-SCRIPT) |
| `src/app/t/.../controls/[controlId]/_tabs/ControlChecksTab.tsx` | Honest "separate telemetry" banner |
| `messages/en.json`, `bg.json` | `checksTab.telemetryNote` |

## Decisions

- **(b) not (a)** — no real script/integration sandbox exists; building one is out
  of scope and (a) would ship a fake engine. (b) turns the no-op into the honest
  awaiting-run state that already existed for MANUAL.
- **Verdict-only denominator** — a pass-rate is `passes / (passes + fails)` by
  definition; counting no-verdict runs is what dragged effectiveness down. `total`
  is kept for display so "N runs" is still truthful.
- **(B) relabel, not (A) wire** — checks have no plan association; wiring them
  through `createAutomatedTestRun` would require a schema-level plan↔check link
  that would misrepresent continuous monitoring as periodic plan runs. The
  explicit plan-scoped bridge (`automation-run` route) remains for the case where
  a result genuinely should become a plan run.
- **MANUAL-with-cron** — the invariant relaxation is the load-bearing model change:
  it lets a cadence exist without claiming a SCRIPT engine. SCRIPT/INTEGRATION are
  reserved for when a real handler is registered.
