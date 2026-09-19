# ADR 0002 — `AgentBehaviourWindow` is allowed to grow, and what makes that safe

**Status**: Accepted — closes the unbounded-growth half of #2539.
**Date**: 2026-09-19.
**Deciders**: Engineering, on the production measurement recorded in #2539.

## Context

`AgentBehaviourWindow` is the agent circuit breaker's hourly ledger: one row
per `(tenant, agent, UTC hour)` holding call counts by capability class, the
distinct tool names reached for, and the verdict recorded for that hour. It is
the baseline every anomaly is measured against.

Nothing sweeps it. It is not in `SOFT_DELETE_MODELS`
(`src/lib/soft-delete.ts`), not in `RETENTION_MODELS`
(`src/app-layer/jobs/data-lifecycle.ts`), and there is no `delete` or
`deleteMany` against `agentBehaviourWindow` anywhere in `src/`. The two
`CASCADE`s declared on the model are the only deletes that exist, and one of
them is unreachable in practice: `RegisteredAgent` is soft-deleted, is absent
from `SOFT_DELETE_MODELS` so nothing promotes that to a hard delete, and
`AgentProposal.agent` / `WorkflowRun.agent` are `onDelete: Restrict`, so an
agent that ever did attributed work cannot be hard-deleted even by hand. Tenant
offboarding is the only reaper this table has.

#2539 split into two questions. The **age-cap** half shipped as #2612 —
`BASELINE_MAX_AGE_HOURS = 90 * 24` in `src/lib/agentic/circuit-breaker.ts`,
deliberately loose, for a reason its docblock states plainly: the numbers that
would justify a tighter value did not exist. This ADR closes the other half:
whether the table needs a retention sweep.

### What was measured

Production (`inflect_compliance`) was queried read-only on 2026-09-19:

| measurement | value |
|---|---|
| rows in `AgentBehaviourWindow` | **0** (`reltuples = -1` — never autovacuumed) |
| rows per agent per month, p50 / p95 | undefined, n = 0 |
| agents between `MIN_BASELINE_WINDOWS` and 2× it | 0 of 0 |
| a stale baseline that produced a bad verdict | no verdict has ever been issued |

The positive control matters as much as the zeros: the same database holds 24
users, 10 tenants and 2,883 `AuditLog` rows, and the static agentic catalogue
is seeded (20 `AgentAssessmentQuestion`, 4 `AgentAssessmentDomain`). The zero
is the table's, not the connection's.

### Why it is empty, which is the part that decides this

The write path is live end to end, not dead code:

```
MCP registry → authorizeToolCall → recordAuthorizedCall (src/lib/mcp/authorize.ts:1177)
             → observeToolCall (src/lib/agentic/circuit-breaker-store.ts:533)
             → INSERT … ON CONFLICT (circuit-breaker-store.ts:131/144/157)
```

It is empty because of the gate immediately above that call
(`src/lib/mcp/authorize.ts:1176`):

```ts
if (inv.governedAgentId !== null) {
    await recordAuthorizedCall(...);
}
```

Production has exercised the MCP surface — 14 `MCP_TOOL_INVOKED` events, the
most recent that same day — and every one carries actor type `API_KEY` with
`"agentId": null`. The gate is correctly skipping them. One `RegisteredAgent`
exists, created 2026-09-04, with zero calls since.

So the blocker is not elapsed time. **No governed agent has ever invoked a tool
in production.** Waiting produces nothing; the three deciding numbers stay
undefined until a governed agent goes live.

### The bound that actually applies

"Unbounded" is the wrong word, and getting it right is what makes the decision
small. Two facts from the code, neither needing production access:

**Growth is rate-capped by a unique index, not by an intention.**
`@@unique([tenantId, agentId, windowStart])` (`prisma/schema/agentic.prisma`)
plus an `INSERT … ON CONFLICT … DO UPDATE` write means one row per agent per
active hour, whatever the traffic. An hour with 100,000 tool calls is one row —
so a flooding agent, the precise thing the breaker exists to catch, adds no
more rows than a dormant one. The ceiling is 24 rows/agent/day, 8,760
rows/agent/year, flat and non-accelerating. At roughly 0.45 KB a row including
indexes, a hundred continuously active agents produce about 390 MB a year, and
the issue's "active two hours a day" profile produces about 33 MB.

**Growth cannot slow any reader.** All three read paths are row-capped on a
prefix of the model's only index, newest-first:

| reader | bound | site |
|---|---|---|
| detector baseline | newest `BASELINE_WINDOW_LIMIT + 1` at/after `baselineEpoch` | `src/lib/agentic/circuit-breaker-store.ts:314` |
| panel look-back | newest `BASELINE_WINDOW_LIMIT + 1` at/after `baselineEpoch` | `src/app-layer/usecases/agent-circuit-breaker.ts:154` |
| panel ledger page | newest `WINDOW_PAGE` (48), unfiltered | `src/app-layer/usecases/agent-circuit-breaker.ts:113` |

169 index entries scanned backwards, independent of the table's size.
`baselineEpoch` only ever moves forward, so it can only shrink that set
further. The union of what any code path can return per `(tenant, agent)` is
the newest 169 rows.

Together: unbounded growth here costs **storage, backups and restore time —
never correctness, never latency.** The usual reason to sweep a hot ledger does
not apply.

## Decision

### 1. No retention sweep, and no tighter cap, on today's evidence

Four reasons, in the order they carry weight:

- **A threshold sized on zero observations is the error #2539 exists to
  prevent.** Every candidate number — a retention age, a retained rank, a
  tighter look-back — is a guess about agent activity, and there is no agent
  activity. This is the same reasoning `BASELINE_MAX_AGE_HOURS`'s docblock
  gives for choosing 90 days loose, now confirmed by measurement rather than
  assumed.
- **The failure mode of capping is that the containment control goes quiet for
  exactly the agents whose behaviour is hardest to read.** An agent active two
  hours a day needs about six days to accumulate `MIN_BASELINE_WINDOWS`; an age
  cap or an age-based sweep can hold it permanently near the threshold, and one
  quiet stretch drops it under into `NO_BASELINE` — a refusal to judge, not an
  all-clear.
- **A pruning job is itself a scheduled job with a failure mode.** It needs
  monitoring, it can stop silently, and its silent-stop failure looks exactly
  like success (a table that stopped growing). Adding one buys a real, ongoing
  operational liability against a hypothetical storage cost of zero bytes.
- **The rows are audit-adjacent.** This is the behavioural history an incident
  review reads to answer "what was this agent doing before it tripped".
  Deleting it is a decision that should be made deliberately, with a stated
  retention period, and not as a side effect of a size worry that measurement
  does not support.

### 2. The reopen trigger is an EVENT, not a date

Re-asking this on a timer produces the same undefined answer, because the
inputs are gated on something a calendar does not move. The trigger is
whichever of these happens first:

- `AgentBehaviourWindow` becomes non-empty, or
- the first `MCP_TOOL_INVOKED` audit event lands with a non-null `agentId`.

Either means a governed agent is calling and the three deciding measurements
have started to exist. #2539 carries them as runnable SQL; the cheapest (table
size from `pg_class`, catalogue-only) may settle the question outright.

### 3. The load-bearing property is the reader bound, and it is guarded

Everything above rests on one line of code per reader. Removing a `take:` would
turn unbounded growth from a storage line item into a latency and memory defect
on the MCP authorization path — and it has **no behavioural signature**:
`evaluateCircuitBreaker` slices its own baseline out of whatever row array it
is handed, so the verdict is identical either way.

That gap was real, and was measured. With the detector's
`take: BASELINE_WINDOW_LIMIT + 1` deleted, five suites and 59 tests that look
like coverage stayed fully green — including
`tests/unit/agent-circuit-breaker-baseline.test.ts`, which asserts
`[WINDOW_PAGE, BASELINE_WINDOW_LIMIT + 1]` but only over the panel's two reads
through a fake client, and
`tests/integration/agent-circuit-breaker-isolation.test.ts`, which drives the
real `evaluateWindow` against fixtures of twelve windows — twelve being below
the cap, so the cap's removal changes nothing it asserts.
`tests/guardrails/query-shape-guardrails.test.ts` does cap unbounded `findMany`
calls, but its population is `src/app-layer/repositories/*.ts` read
non-recursively, and none of this model's three readers live there.

`tests/guards/agent-behaviour-window-reads-are-bounded.test.ts` closes it. It
asserts every row-multiplying read of the model carries a top-level `take:`
resolving to at most `BASELINE_WINDOW_LIMIT + 1` (the constant, imported, not a
retyped literal), that no query shape reaches the model beyond the two known
ones, and that no raw SQL `SELECT`s the table.

## Consequences

### Positive

- No new scheduled job, no new failure mode, no deletion of audit-adjacent
  history, and no breaker stood down for quiet agents.
- The claim that growth is safe is now checkable rather than asserted: the
  property it rests on fails CI when removed.
- The cheapest and safest sweep — keep the newest N per `(tenant, agent)` for
  any N ≥ 169, delete the rest, which by construction removes only rows no code
  path can return — stays available at zero behavioural cost. Its safety is
  contingent on the readers staying row-capped, and that contingency is exactly
  what the guard now pins. The enabling work is done; the sweep waits for a
  non-zero measurement.

### Negative

- The table accumulates without a ceiling once governed agents go live, and a
  retired agent's ledger is immortal in practice: agent retirement reclaims
  nothing, because the agent `CASCADE` has no reachable trigger.
- The decision rests on a measurement of an empty table. It is well-supported
  about what the code can do and says nothing empirical about what a busy fleet
  does, which is why §2 names a trigger rather than closing the question.

### Neutral

- A retired agent's rows are a fixed stock, not a flow — they stop growing the
  hour the agent stops calling. The growing part of the table is only the
  currently-active agent population, which is smaller than "every agent ever
  registered" and is knowable from the agent register without touching this
  table.
- `AgentCircuitBreaker` carries a second staleness axis this ADR does not
  address: evaluation is lazy (it runs only from `recordAuthorizedCall`), so a
  silent agent keeps its last verdict indefinitely and a months-old `STEADY`
  reads as a green light when it means "nobody has looked since". That is
  orthogonal to retention and belongs to its own issue.

## Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Age cap on the detector's look-back | Changes what the detector reads. Stands the breaker down for the quietest agents — the failure mode #2539 identifies. An age cap already exists at 90 days (#2612) and is deliberately loose for the same reason. |
| Age-based retention sweep | The same decision wearing a second hat: for a quiet agent the rows it deletes are still inside the newest 169, so it removes baseline the detector would have read. |
| Rank-based sweep (keep newest N ≥ 169 per agent) | Behavioural cost is genuinely zero — it deletes only rows no reader can return. Rejected **for now**, not on principle: it reclaims zero bytes against zero rows, it is still a scheduled job with a silent-stop failure mode, and it deletes audit-adjacent history. It is the first thing to reach for when the trigger in §2 fires and the size measurement justifies acting. |
| Revisit on a timer (a dated follow-up) | Re-asks a question whose inputs are gated on a governed agent calling, not on elapsed time. It would produce the same undefined answer on every tick, and a tighter cap sized on those undefined numbers is the outcome #2539 exists to prevent. |
| Do nothing at all, record nothing | Leaves `docs/data-retention.md` saying "Growth is NOT bounded" and pointing at a closed issue, and leaves the reader bound — the only thing making growth safe — unguarded in every test directory. |

## Pointers for future changes

- **When the trigger fires** (`AgentBehaviourWindow` non-empty, or an
  `MCP_TOOL_INVOKED` with a non-null `agentId`): run the `pg_class` size query
  from #2539 first. Under a few hundred MB, or under ~1% of the database, this
  ADR stands with more confidence than it has now. Multi-GB, and the rank-based
  sweep is the lever — not an age cap, whose cost falls on the agents the
  breaker is for.
- **Before adding any reader** of this model: the guard requires a top-level
  `take:` at or below `BASELINE_WINDOW_LIMIT + 1`, and a new method shape
  (`count`, `aggregate`, `deleteMany`) fails it deliberately, because those
  return few rows while touching an unbounded number. Raising the cap to fit a
  new reader means reopening this ADR and saying what sweeps the table.
- **If a sweep is ever added**: `docs/data-retention.md`'s row for this model
  must change with it, and `tests/guardrails/retention-policy-coverage.test.ts`
  cross-walks a `runRetentionSweep` claim against what the sweep actually
  queries — a mention alone fails there.
- **Related**: #2539 (this decision), #2612 (`BASELINE_MAX_AGE_HOURS`), #2461
  (the visibility half, closed), and
  `src/lib/agentic/circuit-breaker.ts` for every threshold with its written
  reason.
