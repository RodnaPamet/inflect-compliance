# 2026-07-16 — Consolidate control "effectiveness" onto one measured signal + surface health

**Commit:** `<pending> refactor(controls): one measured effectiveness signal; surface a health verdict`

## Design

"Effectiveness" was forked three ways: ROI/Best-Value read a `Control.effectiveness`
scalar that nothing writes (so they were inert), health + residual each read a
measured 90-day pass rate via their own duplicated `groupBy`, and the "canonical"
`getControlEffectiveness` was exported but dead.

### One canonical measured signal
`control-test.ts` now owns `computeControlEffectivenessMap(db, tenantId,
controlIds[], windowDays)` — ONE `groupBy(['controlId','result'])` over COMPLETED
runs in the window, keyed per control (no N+1). `getControlEffectiveness` is a
single-control wrapper over it. **All three consumers call it:**
- `health.ts` (was an inline `groupBy`),
- `risk-residual-suggestion.ts` (was an inline batched `groupBy`),
- `control-roi.ts` — `getControlRoi` + `getBestValueControls` now compute
  effectiveness as **MEASURED → DECLARED**, the same reconciliation residual
  uses: the measured pass rate wins when a control has test history, else the
  declared `Control.effectiveness` scalar. Payload gains `effectivenessSource`.

**Decision (prompt item 1): make the declared fallback real, not drop it.** Both
ROI and residual share one reconciliation (measured→declared) via one function —
"one notion." To make the declared branch meaningful, `Control.effectiveness` is
now editable (`updateControl` whitelist + `UpdateControlSchema` +
`EditControlModal` field), rather than a write-orphaned column.

### A real, surfaced health verdict
`src/lib/controls/control-health.ts::computeControlHealthVerdict` reduces the
signals — measured pass rate + overdue (age) + accepted exceptions + evidence
freshness — to one gate: `HEALTHY / DEGRADED / AT_RISK / NOT_APPLICABLE /
UNKNOWN`. Detail (`getControlHealth`) passes all signals; the batched
`getControlHealthVerdicts` (list + dashboard) passes the cheap ones (pass rate +
overdue + status), with absent exceptions/evidence treated as "unknown" (neither
positive nor degrading) so it's the same gate, not a second notion. Surfaced as:
a badge on `ControlHealthCard`, a **Health column** on the controls list, and a
**health summary** on the controls dashboard. The `inconclusive` count (computed
all along but dropped from the DTO) is now returned and shown.

### Dead code removed
`markControlTestCompleted` + `POST /controls/[controlId]/test-completed` are
superseded by `attestControlTested` (auto-run on every completed test/check) and
had no UI caller — usecase, route, barrel export, and two test blocks removed.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/control-test.ts` | `computeControlEffectivenessMap` (canonical) + `getControlEffectiveness` wrapper. |
| `src/app-layer/usecases/control/health.ts` | Use canonical; add verdict + openExceptions + inconclusive; `getControlHealthVerdicts`. |
| `src/lib/controls/control-health.ts` | New — `computeControlHealthVerdict` + verdict variants. |
| `src/app-layer/usecases/risk-residual-suggestion.ts` | Use canonical. |
| `src/app-layer/usecases/control-roi.ts` | MEASURED→DECLARED + `effectivenessSource`. |
| `src/app-layer/usecases/control/mutations.ts` · `src/lib/schemas/index.ts` | `effectiveness` editable. |
| `src/app/api/t/[tenantSlug]/controls/health-verdicts/route.ts` | New batched-verdict route. |
| UI: `ControlHealthCard` · `EditControlModal` · `ControlRoiCard` · `ControlsClient` · `controls/dashboard` | Verdict badge + inconclusive + declared editor + source badge + list column + dashboard summary. |
| removed | `markControlTestCompleted` usecase + `test-completed` route. |

## Decisions

- **One reconciliation (measured→declared) shared by ROI + residual** — the
  prompt's "not two notions." The declared scalar is made real (editable) so the
  fallback isn't dead.
- **One verdict gate, best-effort signals** — the list uses the cheap batchable
  signals; detail refines with exceptions + evidence. Absent signals are treated
  as "unknown" (non-degrading), so the two surfaces never contradict.
- **Canonical function is batched** — one `groupBy` for N controls powers the
  list/dashboard/ROI-portfolio without N+1.
