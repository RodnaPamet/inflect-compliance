# 2026-11-15 — Inspect: a run's decision rows (D-EV-8) and Flue's tool-call turn

**Commit:** `feat(evals, agentic): a run's decision rows as JSON (D-EV-8), and Flue tool steps name their model call`

Two owner decisions of 2026-11-15, both for the Inspect harness
(`docs/ai-architecture/inspect.md`). Stacked on the round-3 harness changes (#5709).

## Design

**D-EV-8 — `GET /api/t/:slug/agent-runs/:id/decisions`.** A read-only JSON route
beside the run detail routes. It returns `{ runId, rows, truncated }`, each row
`{ id, inputDigest, agentId, createdAt, humanOutcome }`: the join key and the
outcome code, nothing a sentence could ride in. The usecase is
`readRunDecisionRows` in `src/app-layer/usecases/ai-decision-log.ts`, the module
that already serves `/agents/decisions`.

```
caller ──► edge: JWT + tenant gate, read tier (API_READ_LIMIT)
       ──► route: requirePermission(admin.view OR admin.agent_registry_view)   ← the run detail page's gate
       ──► usecase: assertCanRead + assertMayReadOversightSurface('decisions')  ← the decision log's own rule
       ──► run read under tenantId (404 across tenants), rows where sessionRef = run on a run feature
```

The harness (`runner._decision_rows`) reads it as the OWNER once the run settles,
joins the rows to the MODEL_CALL steps by digest (`ledger.decision_row_facts`) and
records `decisionRows: { readable, total, matched }`. A refused, failed, malformed
or truncated read is `readable: false`. Task 8 now needs that fact: the rows naming
a model step's digest must number the model calls; a missing row is FAIL only when
the read succeeded, and an unreadable read is VACUOUS (NOT_EVIDENCED). Task 4 checks
a refused run wrote no row where the read succeeded.

**Flue's tool-call turn.** Flue records one MODEL_CALL step per dispatch, after
every call in it, so the ledger could not tell a tool call issued in the same
model reply as the flagged read from one issued after it (task 9). The runtime's
`turn` event (one per model call, emitted when the reply ends and before its tool
calls run) carries the reply's `toolCall` blocks, whose ids the tool `run`s then
receive. `executeFlueRun` maps each id to `{ segment: fromSeq, call: n }` and the
TOOL_CALL step (and the `task` delegation step) records it as
`outputJson.modelTurn`. The step projection lifts it into
`RunStepFeedRow.modelTurn` and serves `outputJson` without it. The harness keeps it
as a step fact, and `_turn_relation` / `turnRelation` decide SAME / LATER /
EARLIER from it; a step without it stays VACUOUS.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/ai-decision-log.ts` | `readRunDecisionRows`, `RUN_DECISION_ROWS_CAP` |
| `src/app/api/t/[tenantSlug]/agent-runs/[id]/decisions/route.ts` | The route, the run detail gate |
| `src/lib/security/route-permissions.ts` | The route's rule |
| `src/lib/agentic/flue/execute.ts` | `FlueModelTurn`, the id → call map, the step outputs |
| `src/lib/agentic/flue/turn-tool-calls.ts` | `toolCallIdsOf`: the one read of a `turn` event's reply, ids only |
| `src/lib/agentic/flue/delegation-gate.ts`, `run-binding.ts` | The `task` call's id reaches the delegation step |
| `src/lib/agentic/run-step-projection.ts` | `modelTurnOf`, `RunStepFeedRow.modelTurn` |
| `evals/inspect/inflect_inspect/{product,runner,ledger,verdicts,explain}.py` | The read, the join, the scorers |
| `src/lib/ai/evals/inspect-record.ts` | The record's facts and scorers, in parity |
| `evals/inspect/fixtures/verdict-cases.json`, `product-contract.json` | Golden cases and the route's shape |
| `public/openapi.json` | The route's stub entry |

## Decisions

- **Both gates, never one.** The roadmap row named the steps feed's gate; the
  decision log has its own rule, which reads a tenant switch and so cannot be a
  key in the route map. The route takes the first and the usecase asserts the
  second, so a reader of a run's rows is always a reader of `/agents/decisions`.
  An AUDITOR passes the run's gate and reads only while the owner's switch is on;
  a custom role with `admin.view` and no register key is refused by the second.
  Both refusals write `AUTHZ_DENIED`.
- **Fewer columns than the page.** The page shows the output summary, model and
  tokens; the harness needs none of them, so none is selected. That is also why
  task 7's Flue boundary stays unscored: the rows it reads carry no tokens.
- **A set join, not a per-step one.** A resumed Flue run's dispatches digest the
  same message, so two MODEL_CALL steps can name one digest. The harness counts
  the rows whose digest is in the set the steps name. Digests are joined in the
  harness and never kept: the facts hold two counts.
- **A truncated read is unreadable.** The route reads one past its cap and says
  `truncated`; a count drawn from part of the rows is no count.
- **`outputJson`, not `inputJson`, and no migration.** A TOOL_CALL's input is the
  model's arguments, and a key added to them could not be told from an argument
  of that name (why `subagentName` is a column). Flue's tool outputs are the
  engine's own objects, so a key there is unambiguous. The projection removes it
  before serving `outputJson`, re-serialising the rest in stored order, which
  reproduces the engine's `JSON.stringify` byte for byte; a DONE step's output
  reads `null`, as before. The unpaged `GET /agent-runs/:id` returns stored rows
  and so shows the key; nothing that reads that route parses a tool step's output.
- **The pair, because the ordinal restarts.** `call` counts model calls within a
  dispatch, and a dispatch that ends by throwing records no MODEL_CALL step, so a
  resumed run's two dispatches are not always separated by one. `segment` (the
  dispatch's starting seq) keeps them apart.
- **The reply is read in one module, for ids only.** The `turn` event's
  `response.output` is model output, and `execute.ts` must never read it
  (`flue-model-output-has-one-destination`). `toolCallIdsOf` is the one reader,
  takes the runtime's correlation ids and nothing else, and the guard pins both.
- **Counted from the event, before the usage check.** A call whose provider
  reported no usage is still a call and still issued its tool calls. A worker's
  calls and a compaction count too; each id maps to its own issuing call, so
  that does not merge turns.
