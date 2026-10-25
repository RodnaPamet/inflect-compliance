# 2026-10-25 — An engine-neutral tool core, and `isReasoningEngine`

**Commit:** `<sha>` refactor(agentic): move the engine-neutral tool core out of the Flue adapter

Step 0a of the roadmap in `docs/claude-agent-sdk-design.md` (#4137). The goal is a
second engine that can offer Inflect's tools without importing Flue, and a
`startWorkflowRun` that does not say "Flue" when it means "a model that picks its
own calls". Flue's behaviour does not change.

## Design

```
src/lib/agentic/engine-tools/          no @flue/*, valibot, @earendil-works/* (ESLint)
  review-latch.ts    ReviewLatch, ReviewFlag, StepGuardObservation,
                     GuardObserver, stepVerdictOf
  run-guarded-tool.ts runGuardedTool(inv, name, args, { sourcePrefix, toolCallId,
                     review, origin })   — the guard sandwich around the funnel
  offer-tools.ts     offerToolSet(inv, build, { sourcePrefix, observe,
                     originFor, readOnly }) → { tools, omitted, review }
                     — scope, then autonomy, then the engine's ToolBuilder

src/lib/agentic/flue/tools-adapter.ts  only the Flue shape now
  flueToolsFor  = offerToolSet with a builder that converts JSON schema to
                  valibot and wraps run(context.data, context.toolCallId)
  runGuardedTool(inv, name, args, toolCallId?, review?, origin?)
                = the core with sourcePrefix 'flue' (positional, as before)
  guardDelegateAnswer stays here: a delegate answer is a Flue concept
```

An engine supplies two things: the shape it wants a tool in (a `ToolBuilder`,
which returns `null` to decline a schema it cannot convert) and the prefix for its
guard sources. Everything else is shared. That covers the narrowing, the omission
report, the latch that one run shares across both surfaces, and the call itself,
which goes egress guard → funnel → result guard → result egress guard.

`isReasoningEngine(driver)` in `agent-driver.ts` answers from a
`Readonly<Record<AgentDriver, boolean>>`. A driver added to `AGENT_DRIVERS` with
no classification fails `tsc` at that record and at `DRIVER_IMPLEMENTED`.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/engine-tools/*` | The core, moved verbatim apart from the prefix parameter and the builder seam |
| `src/lib/agentic/flue/tools-adapter.ts` | Flue's tool shape, the valibot conversion, the delegate-answer guard, the positional wrapper |
| `src/lib/agentic/agent-driver.ts` | `isReasoningEngine` and its record |
| `src/app-layer/usecases/workflow-runs.ts` | The registration gate, the skill pin and the worker hand-off ask `isReasoningEngine` (start and resume) |
| `src/app-layer/jobs/audit-narrative-dispatch.ts` | Refuses a non-reasoning driver through the predicate. The outcome code `engine_not_flue` is unchanged |
| `src/app-layer/usecases/tenant-skills.ts` | "Would a run of this workflow mount skills" asks the predicate |
| `eslint.config.mjs` | `no-restricted-imports` over `engine-tools/**` |
| `CLAUDE.md` | New section "Claude agent engines" |

## Decisions

- **The prefix has no default in the core.** If `runGuardedTool` defaulted to
  `'flue'`, the next engine's guard rows would read as Flue's. An investigator
  searches the trail by these strings, because the source is also the guard
  audit row's `entityId`. Only Flue's positional wrapper supplies `'flue'`, and a
  unit test drives Flue's own `run` and pins the three strings.
- **The builder sees a tool only after scope and autonomy.** An engine cannot
  advertise a tool the probe refused, because it is never handed one. A schema
  the builder declines is recorded as `UNCONVERTIBLE_SCHEMA` in candidate order.
  The order is the reason the loop stayed single: two passes would report the
  reasons grouped, not in the order the tools were met.
- **ESLint over a guard file.** The hardening item allows either. A new guard
  file would compete for the `no-epic-named-ratchets` population with two open
  pull requests. An AST rule also catches `import type`, which a source regex
  usually misses. Planting `import type { … } from '@flue/runtime'` and
  `import * as v from 'valibot'` under `engine-tools/` gives two errors.
- **Comparisons with `'flue'` that stay.** The `FLUE` / `STATIC` run label in
  `workflow-runs.ts` names the engine for a person, so it means Flue. So does
  `someWorkflowRequestsFlue` in `agent-driver-policy.ts`, which gates the
  operator's Flue switch, because each engine has its own switch. The Flue-specific
  modules under `flue/` are out of scope by definition.
- **The audit-narrative outcome keeps its code.** `engine_not_flue` is named in
  `CLAUDE.md`, in the integration test, and in the 2026-10-19 note on the
  dispatcher. Renaming it would change behaviour, and 0a is meant to change none.
  It is still true today, because Flue is the only reasoning engine. The step that
  adds a second one renames the code.
- **Two cases added to an integration test.** The mutation
  `isReasoningEngine('flue') === false` was not caught by any assertion on the
  registration gate or the worker hand-off. `workflow-run-skill-pin.test.ts` now
  covers both:
  - an unvouched reasoning-engine run is refused before its row exists;
  - a vouched one is handed to `agent-run-execute`.

  Under the mutation, five of its ten tests fail.
