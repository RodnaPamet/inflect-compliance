# 2026-09-23 — The Flue model call writes an Art 12 decision row

**Commit:** `<sha>` fix(agentic): record an AiDecisionLog row for every Flue model call

Phase 1, point 4. The audit found the decision-log surface (#2771) had nothing
to show for a Flue run: the driver recorded a `MODEL_CALL` step on the ledger
and stopped there. `AiDecisionLog` is the EU AI Act Art 12 record-keeping
table, and a governed agent calling a model is exactly the event it exists for.

## Design

`recordModelDecision` sits immediately after the `MODEL_CALL` `recordStep` in
`executeFlueRun`, inside its own `runInTenantContext`, and **the ledger write
comes first**. The ordering is asserted rather than incidental: the step row is
the run's own account of what it did and must not depend on a governance table
being writable.

The whole call is wrapped in try/catch onto `logger.error`. A failure to
record the Art 12 row must not fail a run that already made the model call —
the call happened whether or not we recorded it, and failing the run would
neither un-make it nor record it.

`modelSpecifier` (`<provider-id>/<model-id>`) is split at the first `/` because
the row has a column for each; a reader filtering by provider should not parse.

`aiSystemId` comes from the run's `RegisteredAgent`. Since #2772 a Flue run is
refused unless an ACTIVE registered agent vouches for it, and that row carries
a non-null `aiSystemId` — so the decision is findable from the AI system it
belongs to, which is the join the registry page needs.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/flue/execute.ts` | `recordModelDecision` + `aiSystemIdFor`; called after the `MODEL_CALL` step |
| `src/lib/agentic/flue/agent.ts` | `useResponseFinish` now reports `tokensIn`/`tokensOut` from `response.usage`, so the row can carry the split |
| `tests/guards/flue-model-call-writes-art12-row.test.ts` | the eight claims above, mutation-proved |

## Decisions

- **`guardVerdict` is deliberately omitted.** The column means "what the guard
  decided about THIS decision", and the model call obtains no such verdict —
  the guard runs over tool calls. Writing an unearned `allow` there would put a
  clearance in the compliance record that nothing ever granted. The guard test
  asserts the ABSENCE of the field, which is the half a reviewer would not
  think to check.
- **`sanitizedInput` is the dispatched message, not the workflow key.** The
  point of the row is what was actually sent. `logAiDecision` bounds and
  sanitises it; a key would be a digest of the wrong thing, and the
  `(tenantId, inputDigest)` join on the decision-log page would never match.
- **`feature` is namespaced `agentic-run:<workflowKey>`** so a tenant running
  three agentic workflows can separate their decisions without joining back to
  the run.
- **Token fields fall back to `null`, not `0`.** A provider that reports no
  usage is unknown, not free.
