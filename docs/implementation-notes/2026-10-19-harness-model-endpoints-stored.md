# 2026-10-19 — The harness scan item keeps the model endpoints a `/2` report names

**Commit:** see the pull request for #3759.

## Design

`inflect-agent-harness/2` (#3754) carries, per agent, an optional `models[]` of
`{ endpoint, model }`. Until now the ingest verified it and kept nothing. The
owner decided on 2026-10-19 that the endpoints are kept so the harness matrix
can show which models each agent calls.

```
report agent.models ──verify (schema + secret walk)──► PlannedAgent.models
                                                       (null = absent)
        ingest: modelsJson = models ?? Prisma.DbNull  ─► AgentHarnessScanItem.modelsJson (JSONB, nullable)
        matrix: parseStoredHarnessModels(modelsJson)   ─► MatrixRow.models
                 NULL → NOT_REPORTED · array passes → REPORTED · else → UNREADABLE
        tab:    Models column, text only
```

The column has three states, not two. NULL is NOT REPORTED: a `/1` scan, or a
`/2` agent without `models`. `[]` is the scanner's claim that the agent calls
no model. A value that fails the strict re-read is UNREADABLE. Each reads
differently on the matrix and none is shown as another.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, migration `20261019110000_agent_harness_scan_item_models` | `AgentHarnessScanItem.modelsJson Json?` |
| `src/lib/agentic/harness-findings.ts` | `PlannedAgent.models`, `null` when the report carried none |
| `src/app-layer/usecases/agent-harness-scans.ts` | Writes the column, `Prisma.DbNull` for absent |
| `src/lib/agentic/harness-contract.ts` | `parseStoredHarnessModels`, the strict re-read |
| `src/lib/agentic/harness-read-model.ts` | `HarnessAgentModels`, `MatrixRow.models` |
| `src/app-layer/usecases/agent-harness-matrix.ts` | Selects and re-reads the column for displayed rows |
| `.../agents/reports/harness/MatrixGrid.tsx` | The Models column |
| `docs/agentic-harness-scanner-dpia.md` | The amendment: endpoints were verified and not kept, and are now kept |

## Decisions

- **A nullable column, not `[]` for absent.** "Not reported" and "reported
  none" are different claims, and a default of `[]` would turn every `/1` scan
  into "this agent calls no model".
- **`Prisma.DbNull`, not `JsonNull`.** The JSON value `null` and SQL NULL read
  back the same through Prisma, but only SQL NULL is what the migration and the
  tests mean. The integration test checks the column with `IS NULL`.
- **Re-read against the contract's own model schema.** The same schema the
  ingest admitted the value with, so a hand-edited row carrying userinfo or a
  secret's shape reads UNREADABLE rather than being rendered.
- **Text only on the matrix.** An endpoint is a reference the scanner chose;
  rendering it as a link would be the relative-link problem
  `evidenceHrefOf` exists to avoid, for no reader benefit.
- **Not added to the `get_discovered_agent` facts read.** Its output feeds two
  skills whose evaluation records are tied to their inputs; adding a member
  there is its own change.
- **No migration backfill.** Scans ingested before this change have NULL and
  read NOT REPORTED, which is true: the column did not exist to hold them.
