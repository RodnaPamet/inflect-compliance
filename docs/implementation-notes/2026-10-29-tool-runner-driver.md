# 2026-10-29 — The Tool Runner driver, built and gated (Claude agents 2b)

**Commit:** `<sha> feat(agentic): build the Tool Runner driver behind DRIVER_IMPLEMENTED = false (Claude agents 2b)`

Step 2b of the roadmap in `docs/claude-tool-runner-design.md` (#4149). The
engine is complete and conformance-proven, and no input selects it:
`DRIVER_IMPLEMENTED['tool-runner']` is false until Step 2c, and `TOOL_RUNNER` is
a READ_ONLY value of `AgentDriverMode`.

## Design

```
runToolRunnerDriver ── planToolRunnerRun ── def.driver, steps left, no skills,
        │                                   clientForRun(residency) ─▶ refusal
        ▼
executeToolRunnerRun
   kill? ─ run row ─ declared input ─ invocation ─ budget ─ wall clock
   tools = toolRunnerToolsFor(...)      ── offerToolSet ── runGuardedTool ── funnel
   none? ─▶ EMPTY_CATALOGUE, nothing sent
   runner = client.beta.messages.toolRunner(lockedParams(...), { signal })
   for await (reply of runner)
       guard the text ─ MODEL_CALL step + Art 12 row (digest of runner.params)
       kill? ─ stop latched? ─ tokens? ─ wall clock? ─ guard verdict? ─ stop reason?
   settle: kill ▸ cap ▸ guard ▸ failure ▸ named stop ▸ iterations ▸ COMPLETED

tool.run ── queue (one at a time) ── stopped? ── charge STEPS/TOOL_CALLS/clock/
            PROPOSALS ── guarded call ── TOOL_CALL step ── kill read ─▶ abort
```

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-driver.ts` | `'tool-runner'`, `STORED_DRIVER_MODES`, the gate's Tool Runner branch |
| `src/lib/agentic/agent-driver-policy.ts`, `usecases/agent-driver-setting.ts` | pass `AGENT_DRIVER_TOOL_RUNNER` |
| `src/lib/agentic/tool-runner/driver.ts` | plan and refusals, the hand-off |
| `src/lib/agentic/tool-runner/execute.ts` | the loop and settlement |
| `src/lib/agentic/tool-runner/tools.ts` | runnable tools over the core, the serial queue |
| `src/lib/agentic/tool-runner/params.ts` | `lockedParams` |
| `src/lib/agentic/tool-runner/model-decision.ts` | one Art 12 row per call |
| `src/lib/agentic/drivers/index.ts` | the driver mapped |
| `src/lib/agentic/drivers/run-settlement.ts` | `haltRunAtKill` names the engine |
| `prisma/migrations/20261029170000_agent_driver_mode_tool_runner/` | `ADD VALUE 'TOOL_RUNNER'`, deploy 1 of 2 |
| `messages/en.json`, `messages/bg.json` | the engine's name, read by the run chip and the settings page |
| `tests/unit/agentic/tool-runner-driver.test.ts` | the conformance suite and the step's hardening list |
| `tests/unit/agentic/tool-runner-locked-params.test.ts` | the parameters, value by value, and the one runner site |

## Decisions

- **The funnel validates the arguments.** The design table puts `argsSchema`
  validation in each tool's `run`. The funnel already validates against the same
  schema, after its gate, and its own comment says nothing may run ahead of the
  gate. A second validator would also be a second catalogue. `run` checks shape.
- **A serial queue, not only `disable_parallel_tool_use`.** The runner starts a
  turn's calls with `Promise.all`. The queue makes one-at-a-time a property of
  the engine, and the test gives the first call the longest latency, so dropping
  the queue reorders the ledger.
- **Stops abort the next request.** Flue checks before every model call through
  its interceptor. The runner has no such hook, so a stop found at a tool aborts
  the run's signal, and the next request is never sent. The loop body's checks
  cover a stop that arrives during the call itself. Each check has a test that
  fails when it is removed alone.
- **The text is guarded before it is recorded.** A call whose text is flagged is
  still on the record, with no output summary.
- **An empty catalogue calls nothing.** There is no answer the run could act on,
  and `tool_choice` with no tools is an API error.
- **No streaming in v1.** Both tiers stay under the SDK's non-streaming ceiling,
  so `stream` is pinned false and each yield is a whole message.
- **The kill message names the engine.** `haltRunAtKill` gained an optional
  prefix, defaulting to Flue's, rather than a second settlement path.
- **A stored `TOOL_RUNNER` reads as itself everywhere.** The run chip, the run
  page and the settings page have its name in both catalogues. Only a rollback
  from a build that wrote it can put one there.
- **Both new test files live under `tests/unit/`.** The guard directories are
  held under a file-count ceiling that main has reached.
