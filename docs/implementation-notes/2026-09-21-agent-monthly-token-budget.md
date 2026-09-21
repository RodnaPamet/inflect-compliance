# 2026-09-21 — The monthly token budget: the one cap that spans runs

**Commit:** `<sha>` feat(agentic): pre-flight monthly token budget for agentic runs

Point 10 of the Flue integration plan, scheduled first on the plan's own
argument that operations *"runs throughout and is the part most likely to be
skipped under time pressure"*. This is its budget half.

It ships **inert**: `agentMonthlyTokenBudget` is nullable, NULL means no budget,
and no tenant has one. Nothing changes until somebody sets a number.

## Design

    spentThisMonth + thisRunsTokenCap > budget   ⟹   refuse, at the door

`run-caps.ts` already bounds a single run on five axes and halts it at the
boundary. That is the right shape for one run and the wrong shape for a month:
nothing accumulates across runs, so a tenant can sit inside every per-run cap
and still spend without limit by starting more of them. This is the only axis
that spans runs, and it is checked exactly once, before the run row exists.

## Files

| File | Role |
|---|---|
| `src/lib/agentic/monthly-budget.ts` | the pure decision — no server imports |
| `src/lib/agentic/monthly-budget-policy.ts` | reads the ceiling, sums the month, throws |
| `src/app-layer/usecases/workflow-runs.ts` | the pre-flight call, above `createSealedRun` |
| `prisma/schema/auth.prisma` + migration | the column and its non-negative CHECK |

## Decisions

### "Would exceed" is answerable, because the run's maximum is known

A run's eventual cost is unknown at the door; its **maximum** is not. The
resolved `TOKENS` cap is a hard bound the run cannot cross without halting, so
comparing `spent + cap` against the budget is a statement rather than a guess.

This refuses a run that *could* exceed rather than one that *will*. That is the
conservative direction and it is the point: the alternative — admit it and stop
when the total actually tips — is mid-flight truncation, which spends the tokens
anyway and leaves the partial state that `WorkflowRun`'s context chain exists to
avoid.

A consequence worth stating: **a budget below one run's token ceiling can never
admit a run.** That is a correct refusal, and the message carries both numbers
so an operator can tell it apart from ordinary over-spend — the fix is to raise
the budget, and no reduction in usage will ever clear it.

### The policy never loads the policy card, and a test guards that shortcut

`resolveRunCaps` narrows exactly one axis by the card — `TOOL_CALLS`, from
`maxActionsPerRun` — and returns `engineCap('TOKENS')` unconditionally. So a
run's token ceiling is `ENGINE_RUN_CAPS.TOKENS` whatever card is in force, and
reading the card here would be a per-run database round trip that cannot change
the answer.

That is exactly the kind of fact that stops being true quietly, so
`tests/unit/agent-monthly-budget.test.ts` asserts the equality directly, across
several card values. When a card gains a token term, that test fails and the
policy has to start reading the card.

### NULL is unlimited — the opposite reading to its neighbours on the same table

`requireRegisteredAgent`, `identity{Leaver,Joiner}Mode` and `agentDriver` all
guard an AUTHORITY, and there the safe end of the switch is "no". A budget is a
LIMIT on something already authorised. Reading its absence as zero would refuse
every agentic run for every tenant on the day it deploys — an outage wearing the
costume of a control.

So NULL is unlimited, matching `null` in `PLAN_LIMITS`. The direction that *is*
fail-closed is the **negative** value: `-1` floors to zero and refuses
everything rather than reading as unlimited, because on a limit the surprising
value must never be the permissive one. A database CHECK refuses the write
outright, so the coercion is a backstop rather than the control.

### It sits above `createSealedRun`, not below

A refusal after the row exists leaves a `RUNNING` run that nothing will ever
advance, which the `agentic-run-settlement` sweep would later reap as a crashed
executor — a refusal indistinguishable, on every surface, from an outage.

### The aggregate does not run for tenants without a budget

A NULL column short-circuits before the sum. Otherwise every run start, for
every tenant, would pay for an aggregate over that tenant's month — on the hot
path, to reach a decision already determined.

## What the mutation proof established, including one thing it disproved

Three mutations against the integration suite:

| mutation | result |
|---|---|
| drop the month window from the aggregate | **2 of 6 red** |
| `>=` instead of `>` at the boundary | **1 of 6 red** |
| drop the `tenantId` filter from the aggregate | **green — and that is correct** |

The third is the interesting one. It looks like a hole in the suite and is not:
`runInTenantContext` issues `SET LOCAL ROLE app_user` inside the transaction, so
the aggregate runs as a non-superuser against a table with `FORCE ROW LEVEL
SECURITY`, and the database scopes it whether or not the application asked.

Measured directly rather than reasoned about: the same aggregate on a plain
client returns **300** with the filter and **9,000,300** without it; inside the
tenant context both return 300. So the explicit filter is the documented
defence-in-depth second layer from `docs/rls-tenant-isolation.md` — not the
thing standing between tenants.

That is written into the test, because a reader who mutates that line, sees
green and concludes the filter is dead code would be deleting one of two layers
and would learn nothing from the suite telling them so.

## What this does not do

No frontend. Point 10 also asks for spend-against-budget on `/agents/reports`
and runs-in-flight on the existing `AgenticGovernanceCard` — neither is here,
and a budget nobody can see is half a feature. It ships first because the
enforcement is what prevents a cost runaway and the display is what explains
one.

Point 10's other halves — Flue in the BullMQ worker rather than the web tier,
`@flue/opentelemetry` into the existing pipeline, and sandboxes asserted off in
code and test — are not in this change either. The sandbox assertion in
particular wants the adapter present to have something real to scan, and that
is still in review.
