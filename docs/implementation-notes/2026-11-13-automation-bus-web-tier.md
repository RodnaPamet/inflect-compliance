# 2026-11-13 — Automation events from the web tier never reached the queue

## Symptom

Inspect run 43429583015 stopped its Tool Runner pass at the first sample:
`rule … had not acted on the trigger task within 120s`. The harness had
created the task over `POST /tasks`; the seeded `TASK_CREATED` rule wrote no
`AutomationExecution` row at all. `tests/integration/inspect-seed.test.ts`
passed throughout, because it calls `runAutomationEventDispatch` itself and so
never goes through the web process's bus.

## Root cause

`emitAutomationEvent` hands each event to the automation bus, whose dispatcher
is a no-op until `installAutomationBusDispatcher()` swaps in the BullMQ one. The
web tier installs it from `src/instrumentation.ts`. The bus was a module-level
`let`, and Next.js compiles `instrumentation.ts` and the route handlers into
different module instances of `automation-bus.ts`. In a `next build --webpack`
of `origin/main`, the instrumentation entry loads chunk 67874, where the bus is
module 354539 and `bus-bootstrap` is the only installer, while the tasks route
loads chunk 68917, where the bus is module 860141 and nothing installs a
dispatcher. So every event emitted from a web request went to the no-op: no
enqueue, no execution row, no rule fired. The worker was not affected, because
esbuild bundles it as one module graph.

The provider registry had the same defect
(`2026-07-08-provider-registry-request-path-fix.md`).

## Fix

The bus lives on `globalThis` (`__inflectAutomationBus`), which every module
instance in the process shares, as the BullMQ queue in `jobs/queue.ts` already
does. `tests/unit/automation-bus-shared-across-module-instances.test.ts` loads
the bootstrap and the bus in two `jest.isolateModules` registries. That is the
same split Next makes. It fails against the module-level `let`.

## Decisions

- **`globalThis` rather than a consumer-graph import.** The registry fix
  imported its bootstrap where the registry is read. Here that would make the
  bus import the queue, which is circular (the bootstrap imports the bus). It
  would also make every unit test that emits an event try to enqueue to Redis.
  A Jest test file runs in its own global, so tests stay isolated.
- **The harness does not score provider failures.** In the same run, three Flue
  submissions failed on a bodiless 503 from the model provider. Flue had
  already retried each one three times. The runs settled `FAILED` as
  `flue_run_failed`, and several scorers read any `FAILED` as a product FAIL.
  The ledger now reduces an engine's catch-all failure that the provider's own
  5xx caused to `model_provider_unavailable`. Both verdict implementations score
  such a sample VACUOUS (never a pass), unless a witness (task 1, 5 or 6) still
  fails it.
