# 2026-09-23 — Flue per-turn token accounting

**Commit:** `<pending> fix(agentic): account per model call, and pay on every exit`

Two linked audit findings against `src/lib/agentic/flue/execute.ts`, fixed as one
change because the second falls out of the first.

## Design

### What the runtime reports, and at which grain

The decision rests on two statements in the runtime's shipped docs, which are the
authority here — not on inference from the hook names.

- `node_modules/@flue/runtime/docs/reference/events.md`, "`turn_start`,
  `turn_request`, `turn`, `turn_messages`": **"One model call is one turn,
  correlated by `turnId`."** `ModelResponse.usage` is **"provider-reported token
  and cost usage for this single call; absent when the provider reported none.
  Turn usage is the leaf level — `operation` and `compaction` roll-ups already
  include it."**
- `agent-hooks-api.md`, `useResponseFinish()`: **"Runs after the final finish
  cycle, when the response is actually settling; its `response.usage` and
  `response.toolCalls` aggregates are final."** `useAgentFinish`'s is **"the
  aggregate usage so far"**, and it runs "at every would-stop point", not per
  turn.

So no hook an agent can declare reports per-call usage. The agent function itself
renders per model call — "the runtime runs the agent function … before every
model call: at each turn" — but "renders are pure reads", so a render cannot
write anything down.

The per-call grain exists on the **event stream**, and `observe()` is the
documented way to read it ("subscribe to live agent-interaction activity emitted
in this isolate"). `execute.ts` already lived on the ESM side of the boundary and
already value-imported `@flue/runtime`, so reading it needed no new module and no
change to the five-file ESM allowlist.

### The shape

```
executeFlueRun
  ├─ turns: TurnRecord[]                 four numbers per model call, nothing else
  ├─ onTurn(event, ctx)                  observe() subscriber: type==='turn' && ctx.id===runId
  │                                      → push { totalTokens, tokensIn, tokensOut, durationMs }
  ├─ settleTurns(finalText)              drain; per call: costTokens += …, one AiDecisionLog row;
  │                                      then ONE updateRun({ costTokens })
  ├─ try   … dispatch/read … recordStep('MODEL_CALL', { tokens: spent, … })
  │        await settleTurns(reply.text ?? null)
  └─ catch await settleTurns(null)        ← the fix for finding 2
```

`observe()` is registered inside the `try` (its disposer is the `finally`) and
before the dispatch, because the stream is live-only — "there is no durable
replay".

## Findings

**1 — the Art 12 row was written per DISPATCH.** `recordModelDecision` ran once,
after `await agent.read(receipt)`, off the response aggregate. A six-turn run left
one `AiDecisionLog` row carrying six calls' summed tokens; the EU AI Act Art 12
record-keeping obligation is per model call and that grain is not recoverable
from the sum. Six calls at 100 tokens and one call at 600 produced the same row.

**2 — token accounting was lost on every throw.** `usage` was read inside the
`try`, so every settle reached from the `catch` persisted a `costTokens` that
excluded the segment just executed. The catch is the *normal* exit for a guard
outcome — `review.check` leaves by throwing on both of its refusal paths — so
every guard-blocked and every guard-flagged run recorded zero tokens for the
dispatch that spent them. `monthly-budget-policy.ts` enforces the tenant's monthly
budget by `_sum: { costTokens }` over `WorkflowRun`, so those tokens were free;
and a FLAGGED run that resumes re-seeds its budget from the row, handing itself
back a ceiling it had already spent.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/flue/execute.ts` | The change: `TurnRecord`, the `observe()` subscriber, `settleTurns` on both exits, per-call `recordModelDecision` |
| `tests/unit/flue-per-turn-accounting.test.ts` | New. Drives `executeFlueRun` with `@flue/runtime` virtually mocked; reads the rows back off `logAiDecision` and the charge off `updateRun` |
| `tests/flue/turn-events-carry-per-call-usage.test.ts` | New. The premise, measured: a real multi-call run through the real runtime, one usage-bearing `turn` event per call the faux provider served |
| `tests/guards/flue-model-call-writes-art12-row.test.ts` | Re-aimed at `settleTurns`; cardinality claims moved to the behavioural test |
| `tests/guards/flue-model-output-has-one-destination.test.ts` | New claim: the per-call path reads `response.usage`, never `response.output` |
| `tests/unit/workflow-step-kind-coverage.test.ts` | Needles follow `turns`; the persist claim is now behavioural |
| `tests/guards/no-raw-prompt-logging.test.ts` | Pair re-measured 173/98 → 174/99 for the one new `logger.warn` |

## Decisions

- **The step ledger stays at ONE `MODEL_CALL` row per dispatch.** It is the
  engine's record of the dispatch and its `seq` feeds the step caps; making it
  per call would change `stepCount` and the cap arithmetic for no regulatory
  gain. Its `tokens` is now the sum of the calls rather than the response
  aggregate — the same number, from the source we actually charge from — and its
  `input` carries `modelCalls` so a reader never has to assume one row meant one
  call.

- **One persist seam for `costTokens`, and the redundant ones were deleted.**
  `settleTurns` is the only place the charge is written. The bare
  `updateRun(ctx, runId, { costTokens })` calls in the two cap arms and in
  `settleAtGuard` are gone: with the flush running ahead of every settle they were
  redundant, and two writers for one number is how the two drift.

- **The settled text goes on the LAST call's row and no other.** A response
  settles when the model stops calling tools, so its text is the last turn's
  output; attaching it to every row would claim each call produced the whole
  answer. On the throw path there is no reply, so every row gets `null`.

- **The turn's own OUTPUT is deliberately not read.** A `turn` event carries
  `response.output` beside the usage, and taking each call's own text for its row
  is the obvious-looking per-call improvement. It is a second, unscanned copy of
  model output arriving through a channel nobody reviews —
  `flue-model-output-has-one-destination` now asserts against it. `TurnRecord`
  carries four numbers and no strings.

- **Compaction turns are charged.** `purpose` distinguishes an agent turn from a
  summarisation one; both are model calls that spent a tenant's tokens, and a
  charge that skipped compaction would under-bill exactly the runs long enough to
  need it.

- **The response aggregate stands behind the per-call charge as a fail-safe.** If
  the event stream ever stops carrying per-call usage, a naive per-turn charge
  silently becomes zero — worse than the aggregate it replaced, because it is a
  hole in the tenant's monthly budget rather than a coarser record. A settled
  response that reported tokens with no observed calls is charged as one call,
  with a `logger.warn` so the degradation is visible rather than silent.

## A third finding, NOT fixed here

**`reply.metadata` is empty on every Flue run, so the aggregate path this change
replaced was already charging zero.** Measured against the real runtime while
writing `tests/flue/turn-events-carry-per-call-usage.test.ts`:

- `InflectAgent` calls `takeRunBinding(runId)`, which REMOVES the binding — "take,
  not get", a deliberate authority property documented in `run-binding.ts`.
- The runtime renders the agent function *before every model call*. The second
  render therefore finds no binding, takes the no-authority branch, and returns
  without `useModel`, without `useTool` and **without `useResponseFinish`**.
- `useResponseFinish` "runs … whatever the current render declares", so at the
  settling render there is no declaration and nothing is merged onto the response
  metadata. `readUsage(reply.metadata)` returns the empty report.

Two measured consequences, both on `@flue/runtime` 2.1.0 with the faux provider:

1. A run scripted with ONE assistant message makes TWO model calls — the second
   render injects the "this run has no resolved authority" instruction into the
   live response and the model is asked again.
2. `reply.metadata` is `undefined` on both a one-call and a two-call run, so the
   shipped `costTokens += usage.totalTokens` added zero every time.

This is not fixed here because the fix is a change to how a run's authority is
addressed, not to accounting, and "take, not get" exists for a reason worth
discussing separately. It is recorded because it inverts a natural reading of the
old code: the per-dispatch row was not merely coarse, it was empty. The new path
is unaffected — the event stream is emitted by the runtime and does not depend on
what a render declared.
