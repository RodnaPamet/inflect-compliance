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

## The switch (owner decision, 2026-11-13)

Fixing the bus wakes every ENABLED rule for new web events at once, and no
tenant has seen its rules act on a web event before. So the fix ships behind
`AUTOMATION_WEB_EVENTS_ENABLED` (`src/env.ts`), off by default:

- **Gate point: the web tier's dispatcher.** `installAutomationBusDispatcher`
  takes a required tier. `instrumentation.ts` installs `'web'`, which is
  `webAutomationDispatcher`: the BullMQ dispatcher behind the switch, read per
  event. `scripts/worker.ts` installs `'worker'`, the plain BullMQ dispatcher,
  which never reads the switch. Each process has its own `globalThis`, so the
  two dispatchers never meet, and worker-emitted events fire exactly as before.
- **Off** holds web events back, as before the fix, and logs
  `automation-bus.web_events_held` once per process. **On** dispatches them.
  Nothing is replayed.
- `agent-evals.yml` turns it on: the Tool Runner samples start from a
  `TASK_CREATED` rule fired over `POST /tasks`. No other workflow depends on a
  web event firing a rule; the E2E jobs run no worker.
- The `VM check` workflow's `automation-rules` check counts the ENABLED rules
  (in all, per trigger event, per action type) and the tenants holding one, so
  the owner can see what would wake. `docs/deployment.md` carries the rollout.

## Decisions

- **The gate is at the dispatcher, not at `emitAutomationEvent`.** An emit-side
  gate would need to know which process it runs in. The dispatcher is installed
  once per process by that process's own startup, so the tier is a fact there,
  not a guess.

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
