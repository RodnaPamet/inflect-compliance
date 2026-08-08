# 2026-07-13 — Control detail synthesis, lifecycle wiring, concept help (R2-P2)

**Commit:** _(R2-P2 of the controls-posture roadmap)_

## Design

The control detail page was 8 self-fetching tabs the user had to assemble into
a judgement, with completion that never advanced control state and no concept
guidance. This adds the missing synthesis + wiring.

- **Completion advances the control.** `completeTestRun` and
  `createAutomatedTestRun` now call a shared `attestControlTested` helper that
  writes `Control.lastTested` (+ rolls the control's cadence) — the state the
  previously un-triggered `markControlTestCompleted` set but no UI ever
  reached. Testing a control (manual OR automated check) finally advances its
  tested-state.
- **Control health synthesis.** A new `getControlHealth` usecase aggregates
  status + applicability + latest manual-test result + latest automated-check
  status + effectiveness (the pass-rate `getControlEffectiveness` computed but
  rendered nowhere) + coverage contribution. `<ControlHealthCard>` renders it
  at the top of the Overview so "is this control implemented and operating?"
  is answered in one place. Skeleton while loading, inline retry on error —
  never a permanent skeleton.
- **Tests vs Checks clarified.** Both tabs carry a one-line on-screen
  explanation (manual test plans vs automated integration checks) noting the
  check→test bridge (`createAutomatedTestRun`).
- **Concept help.** The Overview fields (successCriteria / category /
  frequency / automationType / mitigationType) each carry an `InfoTooltip`
  (via a `ConceptEyebrow` helper reusing the NewControlModal applicability
  pattern) explaining the term in plain language.
- **Lifecycle fixes.** Run-launch in `TestPlansPanel` uses `router.push`
  instead of `window.location.href`; the control Evidence tab deep-links each
  row to its specific record (`/evidence?ev=<id>` — `EvidenceClient` gained
  `?ev=` sheet-open support) instead of the whole library; the overloaded
  evidence "Status" column is split into "Added by" (provenance) + "Status"
  (approval), so a creator name is never mistaken for an approval status.

## Decisions

- **Attest lastTested on every completion, don't auto-advance status.** A
  single passing run isn't proof of implementation, so completion stamps the
  tested-timestamp and surfaces effectiveness; advancing `status` stays a
  deliberate user action (the detail dropdown, now exposing all statuses per
  R2-P1). The health card gives them the evidence to decide.
- **Deep-link via `?ev=` not a new route.** Evidence has no `/evidence/[id]`
  route — the detail sheet is state-driven. Adding a query-param opener is the
  minimal, reversible way to make records addressable from other surfaces.

## Deferred (scoped follow-ups, documented not dropped)

- `NewControlModal` still omits objective / successCriteria /
  testingMethodology that the edit modal carries — aligning the create form is
  a self-contained follow-up.
- The hand-rolled applicability radio card → standard `<Modal>` migration is a
  larger UI refactor; the card is functional and now sits beside the health
  synthesis.
- The "double CONTROL_GAP task" premise was **stale** — `completeTestRun` and
  `createAutomatedTestRun` are mutually-exclusive paths, one task per run, not
  a duplicate. No change made.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/control-test.ts` | `attestControlTested`; wired into both completion paths |
| `src/app-layer/usecases/control/health.ts` | NEW — `getControlHealth` synthesis |
| `.../controls/[controlId]/health/route.ts` | NEW — health API route |
| `.../controls/[controlId]/_tabs/ControlHealthCard.tsx` | NEW — Overview synthesis card |
| `.../controls/[controlId]/page.tsx` | mounts the card; ConceptEyebrow tooltips; Tests/Checks explanations |
| `src/components/TestPlansPanel.tsx` | run-launch → `router.push` |
| `.../controls/[controlId]/_tabs/EvidenceSubTable.tsx` | record deep-link; Status column split |
| `.../evidence/EvidenceClient.tsx` | `?ev=` deep-link sheet opener |
| `tests/guards/p2-control-detail-synthesis.test.ts` | ratchet |
