# 2026-09-20 — Run provenance on proposals, and two step kinds for a driver

**Commit:** `<sha>` feat(agentic): run provenance on proposals + MODEL_CALL/TOOL_CALL step kinds (1/3)

PR 1 of three preparing the agent **driver seam** — the ability to run this
product's agents on an external agent runtime without moving any control out of
the register. This one is schema only. It adds nothing that executes.

The companion note
[2026-09-20-flue-2-1-0-api-verification.md](2026-09-20-flue-2-1-0-api-verification.md)
records what the runtime's published API does and does not offer; the caveat on
`MODEL_CALL` below is a direct consequence of it.

## Design

Two independent changes that a single migration carries because they are one
deploy:

**`AgentProposal.(runId, stepSeq)`** — propose-not-commit is the only write path
an agent has, so this pair is what makes a queued write traceable back to the
reasoning that produced it. `(runId, stepSeq)` addresses one `WorkflowStep`,
whose `toolCalled` / `inputJson` / `outputJson` are the narrative and whose run
carries the sealed context chain. Without it a proposal is attributable to an
agent and a policy-card version — both already pinned on the row — but not to a
moment.

**`WorkflowStepKind += MODEL_CALL, TOOL_CALL`** — so that a run executed by an
external runtime lands the same narrative in `WorkflowStep` as a hand-written
one. `WorkflowRun` stays the system of record; the driver reports into it rather
than keeping its own. No new columns were needed: `seq`, `toolCalled`,
`inputJson` and `outputJson` already carry everything both kinds need.

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma` | the two new step kinds, and the granularity caveat on `MODEL_CALL` |
| `prisma/schema/agentic.prisma` | `runId` / `stepSeq`, the composite FK, the tenant-leading index, the `WorkflowRun.proposals` back-relation |
| `prisma/migrations/20260920120000_agent_proposal_run_provenance/` | hand-written; see below |
| `tests/integration/agent-proposal-run-provenance.test.ts` | what Postgres refuses, each refusal paired with an accept |

## Decisions

### `MODEL_CALL` is per RESPONSE, and the name overstates it

The runtime's public API surfaces model activity only through
`useResponseFinish`, whose `response.usage` is documented as *"aggregate usage
across all turns and re-attempts"*. There is no per-invocation hook:
`useModel(model, options)` takes `thinkingLevel` and `compaction`, and the
response lifecycle callbacks are typed `ResponseMetadataCallback` — carrying
neither the prompt nor the output text.

So one `MODEL_CALL` row covers a whole response and its token figures are a sum.
**Counting these rows counts responses, never model invocations.** A
per-invocation row is reachable only by registering a provider through
`@flue/runtime/internal` + `setProvider`, which means depending on a non-public
export and on a pre-1.0 `@earendil-works/pi-ai` three minors ahead of the
runtime's own pin. Not taken.

The value is still named `MODEL_CALL` rather than `RESPONSE` so that taking that
seam later changes row *density* and nothing else — no enum value retires, no
rows are rewritten, no migration is needed for the granularity to improve. The
cost is a name that promises more than the row holds, which is why the enum's
docstring carries the caveat at length. That docstring is the only thing standing
between the name and a wrong reading of a `COUNT(*)`.

`TOOL_CALL` carries no such caveat, and gets a cross-check for free: every tool
call this product admits also passes through `runReadTool`, which audits it
independently. Two records of one event by different paths — so a `TOOL_CALL`
step with no matching `MCP_TOOL_INVOKED` audit row is a signal, not a gap.

### Both columns are nullable, and NULL is an answer

A proposal made outside a run. The propose tools are callable by an agent that
is not executing a workflow, so such a proposal genuinely has no step. This is
not a legacy state awaiting a backfill, and reading NULL as "unknown run" would
invent a run that never existed. The first test asserts the accept explicitly so
a later "tighten this up" PR fails rather than forbidding a state the product
produces.

### `stepSeq` gets a CHECK because it cannot get a foreign key

`WorkflowStep` is keyed `(runId, seq)` as an INDEX, not a unique constraint —
one step may record several proposals — so Postgres has no unique target for a
composite FK on the pair. `AgentProposal_step_requires_run` carries the half
that is enforceable: a step ordinal naming no run addresses nothing, so it must
not be storable. Same shape as the `AgentProposal_update_requires_target` CHECK
beside it.

### The migration is hand-written, and that was not a preference

`prisma migrate diff` against this migrations directory emits **275 lines**: the
four statements this change needs, plus 39 `DROP CONSTRAINT` / `ADD CONSTRAINT`
pairs under *identical* names, three `emailHash DROP NOT NULL`s, and a
`DROP INDEX "Control_objective_trgm_idx"`. That is pre-existing drift between
the directory and the schema — the dropped and added constraint sets are equal
apart from this change's own new FK, and none of it touches `AgentProposal` or
`WorkflowRun`.

Shipping the generated file would have hidden four intended statements inside
that churn and dropped a trigram index this change knows nothing about. The four
statements below are the generated ones for *this* diff, copied verbatim; the
CHECK is added by hand. **The drift itself is left alone** — it is real, it
predates this work, and folding a 271-line incidental fix into a schema PR is
how a rollback stops being a revert.

### Adding enum values is safe here, for the opposite reason to the `@@map` pins

Those pins guard `ALTER TYPE … RENAME`, which breaks still-running old
containers mid-deploy with SQLSTATE 42704. Adding a value runs the other way: it
is invisible to an old container **until a new one writes a row carrying it**.
Nothing writes these until the `flue` driver is enabled, and that flag is off by
default and fails closed — so the window in which an old container could meet an
unknown value never opens during the deploy that adds them.

## What was proved, and how

The constraints were exercised against a real database before the test was
written, and the test was then mutation-proved: dropping
`AgentProposal_step_requires_run` turns **3 of 8** tests red, restoring it turns
them green. Each refusal is paired with an insert that must succeed, and a final
assertion pins the surviving rows — without those, a broken fixture produces the
same "the insert was rejected" that a working constraint does, and the suite
would report the constraint as proven while testing nothing.

The enum assertion reads `pg_enum`, not the generated client — comparing the
client to the schema would compare the schema to itself and pass against a
database that never got the migration. It discriminates: the same query returns
4 values on an un-migrated database and 6 on a migrated one.

## Rollback

`ALTER TABLE "AgentProposal" DROP CONSTRAINT "AgentProposal_step_requires_run"`,
drop the FK and index, drop the two columns. **The two enum values cannot be
dropped** — Postgres cannot remove an enum value without recreating the type,
which is the mid-deploy hazard the `@@map` pins exist to avoid. They would
remain, unused and unwritten, exactly as `PROPOSE` remains on
`IdentityWriteMode` after that rung was retired. Nothing reads them, and no code
path can produce one while the driver flag is off.

Risk is low: every column is nullable, every constraint is new, no existing row
is touched, no backfill runs, and nothing in the product writes to any of it yet.
