# 2026-10-25 — Flue asks the kill switch and the caps before every model call

**Commit:** `<sha> fix(agentic): Flue asks the kill switch and the caps before every model call`

Fixes #4196, found by the driver conformance suite (Step 0b, #4138). The owner
decided on 2026-10-25 that Flue is fixed before 0b lands.

## The defect

The kill switch was asked twice in a Flue run. It was asked once, before boot,
and then only at the tool boundary, through the funnel's `assertNotKilled`. A
kill engaged mid-run refused each tool call, but the refusal reached the model
as an ordinary tool error. The model was called again, and the run settled
`COMPLETED`.

Measured with a kill engaged after the first model call: three external model
calls, no funnel call, status `COMPLETED`. A killed agent kept sending tenant
content to the model provider for the rest of its dispatch. A run that made no
tool call after the kill was never stopped at all.

The caps had the same shape. A cap that latched at a tool call refused later
tool calls, but the model was still called. With a TOOL_CALLS cap of 1 the
model was called four times. The token cap was charged only after the
dispatch, so a long dispatch could run as far past it as the model liked.

## Design

```
executeFlueRun
  binds the run with beforeModelCall, a closure over ctx, the cap latch and the budget
    1. a cap latched at a tool call      → throw (settled at that cap)
    2. resolveKillState, uncached         → latch the verdict, throw
    3. budget.charge('RUNTIME_MS', 0)     → latch, throw
    4. budget.charge('TOKENS', spent so far in this dispatch) → latch, throw

flue/telemetry.ts interceptor, on the first sight of each model operation
  await binding.beforeModelCall()   (a throw means next() never runs: nothing is sent)

settle, on both the catch and the success path
  killed.verdict → haltRunAtKill    (before the cap arm)
  latch.halt     → haltRunAtCap     (unchanged)
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/run-binding.ts` | `beforeModelCall` on the binding |
| `src/lib/agentic/flue/telemetry.ts` | The interceptor awaits it, once per model call |
| `src/lib/agentic/flue/execute.ts` | Builds it, and settles a mid-run kill as `ABORTED` |

## Decisions

- **The check lives in the interceptor because nothing else is async and sees
  every model call.** The agent function re-renders before every model call,
  but it must be synchronous. The kill read reaches Prisma, which the
  interceptor's ESM graph cannot load, so the binding carries a callback, as it
  already does for the delegate-answer guard.
- **Once per model operation object, not once per interception.** The runtime
  intercepts one model call to open the provider stream, then once per
  streamed chunk and once for `result()`, all with the same operation object
  (`wrapProviderStream`). Asking every time read the kill switch eight times
  per call. A transient retry builds a fresh operation object and is a new
  provider call, so it is asked again. The test pins one ask per call, so a
  runtime that changed either behaviour fails it.
- **Delegates are covered.** A delegate's model call carries the parent run's
  `instanceId`, so the parent's binding is found. The test measures this
  (parent, delegate, parent: three asks).
- **Compaction is covered too.** Its summarisation call is also a `model`
  operation, and it is also a call to the provider.
- **A kill read that throws refuses the call.** That fails closed, as
  `assertNotKilled` does, and the run settles `FAILED` naming the read error.
- **A kill wins over a cap at settlement.** A run that was killed and also hit a
  cap is reported as killed. Before the call, a cap that has already latched
  is reported first, because it is the earlier event and the run is already
  over.
- **The token check charges what the dispatch has spent so far.** `turns`
  holds each settled call's usage, so the check charges the calls made so far.
  The final charge after the dispatch then adds only the remainder. The
  budget's charge is all or nothing, so nothing is counted twice.
- **No tool-boundary change.** The funnel still refuses a killed agent's tool
  call. That refusal stays the backstop for a tool call already in flight
  when the switch is engaged.
