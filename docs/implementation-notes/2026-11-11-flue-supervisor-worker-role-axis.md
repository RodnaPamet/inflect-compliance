# 2026-11-11 — The supervisor/worker role axis on the Flue engine

**Commit:** see the `wf/role-axis` branch (nemotron-reasoning Phase 1, D-L3-1).

## Design

D-L3-1 (owner, 2026-11-11) adopts a role axis in model selection. A Flue
run's own model calls are the **supervisor**'s; its subagents (the four
specialists in `flue/subagents/`) are the **worker**'s.

```
tenant residency ──► resolveFlueRoleModels(sel)
                       ├─ supervisor: resolveFlueModel({ ...sel, role: 'supervisor' })
                       └─ worker:     resolveFlueModel({ ...sel, role: 'worker' })
EXTERNAL   supervisor = inflect-external/AGENT_FLUE_MODEL
           worker     = inflect-external/AGENT_FLUE_WORKER_MODEL      (CONFIGURED)
                      | the supervisor's specifier                    (worker_fallback)
LOCAL_ONLY both       = inflect-local/AI_LOCAL_MODEL, or the same named refusal
```

The role chooses a model id, never a route. Both roles are resolved under
one set of residency terms, and the LOCAL_ONLY short-circuit sits above the
worker branch, so a LOCAL_ONLY tenant's worker cannot reach the external
provider whatever the deployment configures.

Where the answers go:

- `planFlueRun` returns `workerModelSpecifier` and `workerBasis` beside
  `modelSpecifier`; the driver hands the worker specifier to `executeFlueRun`,
  which binds it on the run.
- `executeFlueRun` refuses, before anything is sent, a worker whose provider
  differs from the supervisor's (`flue_worker_route_mismatch`, via
  `onSameRoute`) and a worker model the runtime did not register
  (`flue_model_not_registered`).
- `agent.ts` sets a delegate's `model` through `workerModelOverride`, which
  answers `undefined` when the worker equals the supervisor, so the delegate
  definition is the one it always was.
- The external provider registers the worker model beside the supervisor's
  (`buildFlueProviders`), never alone, and only when the two differ.
- Per-turn accounting: a `turn` event that carries the runtime's `taskId` is a
  worker call. Its Art 12 decision row names the worker's model, and the
  `MODEL_CALL` step carries `tokensByRole`. `costTokens`, the caps and the
  monthly budget are charged the total, as before.
- `WORKFLOW_RUN_STARTED` carries `modelSupervisor`, `modelWorker`,
  `modelWorkerBasis` and `modelRefusal`, resolved from the tenant's residency
  before the row exists, on a run the Flue engine walks; every other engine
  records the four keys as null.

## Files

| File | Role |
| --- | --- |
| `src/env.ts` | `AGENT_FLUE_WORKER_MODEL`, optional |
| `src/lib/agentic/flue/model-selection.ts` | `FlueModelRole`, the `role` term, `resolveFlueRoleModels`, `flueOpeningModels`, `onSameRoute` |
| `src/lib/agentic/flue/driver-plan.ts`, `driver.ts` | the plan carries both roles; `WORKER_ROUTE_MISMATCH` refusal |
| `src/lib/agentic/flue/execute.ts` | route and registration checks for the worker; per-turn role labels |
| `src/lib/agentic/flue/run-binding.ts`, `agent.ts`, `subagents/index.ts` | the worker specifier reaches the delegate definition |
| `src/lib/agentic/flue/providers.ts`, `runtime-start.ts` | the worker model is registered on the external provider |
| `src/app-layer/usecases/workflow-runs.ts` | both role models in the opening audit entry |

## Decisions

- **Defaults are the old behaviour.** A supervisor answer never carries the
  new `fallback` key, so `resolveFlueModel`'s existing callers see the same
  object. With no worker configured the delegate gets no `model` override and
  the provider registers one model, as before.
- **No local worker for an EXTERNAL tenant.** The roadmap's "or
  `AI_LOCAL_MODEL` on `inflect-local` once Layer 5 exists" is Layer 5 work,
  optional and last. Today an EXTERNAL tenant's worker is an API-key model on
  the external provider or the supervisor's model.
- **No new sub-processor.** The worker is a model on the provider already
  registered for agent runs, with the same key; `docs/sub-processors.md`
  records the variable on the Anthropic row and the row's data category is
  unchanged.
- **The opening entry records null rather than omitting keys** on non-Flue
  runs. A conditional spread would be a new hole for `no-raw-prompt-logging`,
  and an `undefined` value would make the hashed and the stored shapes differ.
- **The Tool Runner gets no worker role.** It has no delegates, its model is
  the profile tier's, and `clientForRun` decides residency independent of
  role, so there is nothing for the worker axis to select there.
- **Role is read from `taskId` on the turn event**, not from the model the
  runtime reports, so a deployment whose worker equals its supervisor still
  labels delegate tokens as the worker's.
