# 2026-10-29 — Turn the Tool Runner engine on (Claude agents 2c)

**Commit:** `feat(agents): turn the Tool Runner engine on — DRIVER_IMPLEMENTED['tool-runner'] = true (Claude agents 2c)` and the three commits around it

## Design

```
Admin → AI features → Agent engines        Behaviour tab (agent page)
  owner chooses TOOL_RUNNER                   "Test run" on v<n>
        │                                           │
        ▼                                           ▼
  TenantSecuritySettings.agentDriver      POST …/profile/versions/:v/test-run
                                           startAgentProfileTestRun
                                             person? version SUBMITTED or in force?
                                             TEST_RUN allowed? engine runs profiles?
                                             agent active, scored, not killed?
                                                    │  { ...ctx, agentId }, read authority
                                                    ▼
                                           startWorkflowRun(key …:test-run, profileTrigger)
                                             resolveRunDefinition → driver 'tool-runner', readOnly
                                             admission, pin version + hash, enqueue
                                                    │
                                                    ▼
                                           worker: executeQueuedWorkflowRun
                                             resolvePinnedRunDefinition (the pin, not approval)
                                             Tool Runner driver → Messages API → funnel
```

Production was confirmed to read `TOOL_RUNNER` before any writer accepted it:
`/api/health` reported `a8ba6717`, which contains 2b's merge and migration, and
the entrypoint applies migrations under `set -e` before the app starts. The
record is on #4150.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-driver.ts` | `TOOL_RUNNER` WRITTEN; the flag, in a commit of its own |
| `src/lib/agentic/agent-driver-policy.ts` | The fourth gate learns the Tool Runner (`somethingRequestsToolRunner`) |
| `src/app-layer/usecases/agent-driver-setting.ts`, `flue-wiring.ts` | The Tool Runner's own switch, build and checklist |
| `src/app/t/[tenantSlug]/(app)/admin/ai-features/*` | The settings section names the chosen engine; per-engine choice |
| `src/lib/agentic/agent-profile.ts` | `runsProfiles` true for the Tool Runner; the `:test-run` key |
| `src/app-layer/usecases/agent-profile-runs.ts` | Test-run admission; `resolvePinnedRunDefinition` |
| `src/app-layer/usecases/workflow-runs.ts` | The trigger into admission; the worker and resume read the pin |
| `src/app-layer/usecases/agent-profiles.ts`, the `test-run` route | The Test-run usecase and `testRun` states |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/BehaviourTab.tsx` | The button, its reasons, and the Runs tab hand-off |
| `docs/sub-processors.md` | "tenant-authored agent instructions" on the Anthropic row, entry (d) |

## Decisions

- **The worker read the registry, which knows no profile key.** Before 2c no
  profile run could be admitted, so it never mattered. Every profile run the
  worker picked up would have failed `workflow_definition_missing`. The worker
  and resume now rebuild the definition from the run's own `profileVersionId`
  while its instructions hash to the pinned hash, so a version approved,
  rejected or superseded mid-run changes nothing about the run.
- **The Test run lives in the run key, not a column.** A read-only Test run of
  a profile whose output kind allows proposals must stay read-only when the
  worker rebuilds the definition, and the run row had nothing that said so. The
  `:test-run` suffix says it to every later reader, with no migration. Admission
  accepts that key only when the caller passes `profileTrigger: 'TEST_RUN'`, so
  the generic start route cannot use it to run a SUBMITTED version.
- **The fourth gate needs the tenant for the Tool Runner, and only the
  reporting surfaces apply it.** Profiles, not the registry, ask for this
  engine, and the profile surface can be on for one tenant only. Narrowing on
  the run path without the slug would have sent an allowlisted tenant's profile
  runs to the static engine.
- **Each engine is offered only while its own switch is on.** With Flue on and
  the Tool Runner off, choosing the Tool Runner would store a choice that runs
  nothing, which the `deployment-off` rule exists to prevent.
- **Completion is proved in an integration test, not E2E** (owner decision,
  2026-10-29, #4150). No fake model exists in product code and the E2E job runs
  no worker. The owner chose not to add either; the E2E spec stops at the run
  starting.
