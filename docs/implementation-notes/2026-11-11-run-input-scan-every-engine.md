# 2026-11-11 — Run input is scanned before every engine (Flue residuals F5, F12, F3)

**Commit:** see branch `wf/f5-run-input-scan` (NeMo Guardrails roadmap, Phase 0, sub-phase 0.1)

## Design

The 2026-10-09 Flue audit (against 3.164.1) recorded F5: `guardUntrustedInput`
lived only in the tools adapter, so a run's initial input reached prompt
assembly unscanned. Re-verified on 3.364.1 (`f1644fb26`), F5 is closed, and
was closed by #3468 rather than by anything here:

```
startWorkflowRun
  assertRequiredInputPresent
  assertWithinMonthlyBudget / assertWithinConcurrencyCap
  guardUntrustedInput(scannableInput(input))   ← every string value, nested too
  assertNoReviewRequired                       ← flag AND block refuse; audit allows
  resolveDriverForRun → selectRunDriver        ← the engine is chosen AFTER the scan
  register gate (reasoning engines only)
  createSealedRun                              ← its only caller; input sealed once
        │
        ▼  (worker, any segment)
  openDeclaredRunInput (sealed, chain-verified) → runMessage   ← Flue AND Tool Runner
```

So the bytes a model sees are the bytes that were scanned: both engines read
the declared keys out of the sealed context, then clean, neutralise, fence and
label them (`agent.run-input`). Other text that reaches a model on these
engines was checked too: a profile's instructions are scanned by the guard's
own injection scanner at save and approval (any verdict refuses) and
re-hashed at every resolution; Flue's A2A peer replies are guarded per reply
on delivery; the assistant's question and page context pass the scanner at its
door (pinned in `tests/unit/usecases/assistant.test.ts`).

What was missing was a pin on the "every engine" half. The existing integration
test starts every run on the static engine (no switch on), so a scan moved
below the driver choice, or gated on the static engine, would have left it
green. The new integration test turns both switches on, has a tenant choose
each reasoning engine, and asserts the hostile input is refused by the guard
while the clean control reaches the register gate, which only a reasoning
engine asks. It also pins the arms: STRICT (block) refuses, AUDIT (allow)
creates the run.

## Files

| File | Role |
| --- | --- |
| `tests/integration/run-input-scan-precedes-every-engine.test.ts` | New: the admission scan precedes Flue and the Tool Runner; strict/audit arms |
| `src/app-layer/usecases/workflow-runs.ts` | Comments only (F12): the driver-selection block's stale claims |
| `docs/ai-architecture/nemo-guardrails.md` | 0.1 checked with the evidence; D-L1-2 recorded as decided |

## Decisions

- **No code change for F5.** The scan exists at the one door every run passes;
  adding a second scan inside each engine would scan the same sealed bytes
  twice and give a second place for the two to disagree.
- **A flag at admission refuses; it does not latch review.** Mid-run a `flag`
  parks the run for a human. At the start there is no run to park, and writing
  a RUNNING row only to park it is the "refusal wearing the costume of an
  outage" the budget and register gates already avoid. Left for the owner as a
  question, not changed.
- **Mutation-checked.** Moving the scan below the driver choice and gating it on
  the static engine fails the two hostile reasoning-engine cells while the
  sibling static-engine file stays green; replacing `assertNoReviewRequired`
  with "any non-clean verdict refuses" fails the AUDIT cell.
- **F12 fixed by naming where to look, not how many.** The comment was
  corrected once (#3469) to "two definitions set `driver`" and was wrong again
  within weeks (six registered workflows ask for `flue`, and every compiled
  profile asks for `tool-runner`). It now points at the two places definitions
  live. Three neighbouring claims in the same block had decayed the same way
  and were corrected with it: the `'static' | 'flue'` union (the `AgentDriver`
  union now has three members), "two definitions ask for flue", and "no engine
  runs a profile yet" (the Tool Runner has since #4150).
- **F3, reported, unchanged.** `PERMITTED_FLUE_PACKAGES` in
  `src/lib/agentic/flue/refused-capabilities.ts` is `['@flue/runtime']`, so
  `@flue/opentelemetry` is refused both as an import and as a `package.json`
  dependency by `tests/guards/flue-refused-capabilities.test.ts`. It is not
  declared or installed; the product's Flue telemetry is its own interceptor
  (`flue/telemetry.ts`, `instrument` from `@flue/runtime`) feeding
  `@/lib/observability/tracing`.
