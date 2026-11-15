# 2026-11-15 — Tool Runner model capabilities

**Commit:** `fix(agentic): send each Tool Runner model only the parameters it accepts`

## Design

Inspect run 43715891271 set `AGENT_TOOL_RUNNER_MODEL_BALANCED` and `_DEEP` to
`claude-haiku-4-5`. Every Tool Runner run settled FAILED with
`tool_runner_run_failed` on the provider's HTTP 400, with no model step and no
tokens, while Flue succeeded on the same model id. The Tool Runner sent every
model adaptive thinking, `output_config.effort` and `fallbacks: 'default'`, and
Haiku 4.5 accepts only a `budget_tokens` thinking configuration and no effort.

Owner decision (2026-11-15): the engine adapts.

```
toolRunnerModelFor(tier) | resume.model ──► model id
                                              │
                         modelCapabilitiesFor(model)   model-capabilities.ts
                                              │         (closed Record by family;
                                              ▼          unknown → conservative)
lockedParams ── always: stream, thread:false, model, max_tokens, max_iterations,
                        system, messages, tools, tool_choice
             └─ only if the row says so: thinking, output_config, fallbacks + betas
```

A provider error now logs one warn line (status, error type, the provider's
message truncated to 300 characters, its request id) and the Inspect harness's
settled line prints the error type beside the HTTP status.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/tool-runner/model-capabilities.ts` | The capability table, the family matcher and the conservative set |
| `src/lib/agentic/tool-runner/params.ts` | `lockedParams` reads the row; `compactionParams` copies only the members the runner has |
| `src/lib/agentic/tool-runner/execute.ts` | `providerErrorOf` and the one log line in the loop's catch |
| `evals/inspect/inflect_inspect/runner.py` | `provider_error_type`, printed in the settled line |

## Decisions

- **An unknown model fails closed to the request every model accepts**, not to
  the newest parameters and not to a refusal. Each conditional member is refused
  by at least one current model, so omitting all three is the only set none
  refuses, and omitting `thinking` is never a 400.
- **A `budget`-only model gets no thinking.** A budget is a token count the
  engine would have to invent from an effort level, and interleaved thinking on
  those models needs another beta.
- **`fallbacks` only where the reference says the scalar form is accepted and
  means something** (Fable 5 family, Opus 5 and 5.5, Sonnet 5.5). The beta header
  goes with the parameter, never alone.
- **A resume reads the STORED model's row**, because that is the model the
  request names.
- **The stored `errorMessage` keeps the SDK's form** (`tool_runner_run_failed:
  <status> {<provider JSON>}`), which already carries the type and message. The
  harness parses that form for the status and the 5xx classification. The
  harness logs codes only, so it reads the type and never the message; the worker
  log line, which the workflow prints at warn level, carries the message.
