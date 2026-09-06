# 2026-09-06 — Agent run caps: composed ceilings that HALT, never truncate

**Commit:** `feat(agentic): bound what one agent run may spend, and HALT at the ceiling (ASI08)`
(sole commit on `feat/agentic-9b`; the sha is assigned at squash-merge)

OWASP **ASI08 (cascading failures)** is rarely one tool doing something
catastrophic. It is a loop: an agent that reads, proposes, re-reads and proposes
again at machine speed until the review queue is unusable and the bill is real.
Propose-not-commit already bounds what ONE action can do. What was unbounded is
HOW MANY.

## Design

### Five axes, one composition

```
ENGINE_CAPS (workflow-types.ts)          AgentPolicyCardVersion
  MAX_STEPS      50                        maxActionsPerRun  (ACTION_CAP_LADDER)
  MAX_TOKENS     200_000                   maxActionsPerDay  (ACTION_CAP_LADDER)
  WALL_CLOCK_MS  3_600_000
        │                                          │
        └────────────► resolveRunCaps(card|null) ◄──┘
                              │  strictest wins
                              ▼
        { STEPS, TOOL_CALLS, PROPOSALS, TOKENS, RUNTIME_MS }
                each { limit, source: 'ENGINE' | 'POLICY_CARD' }
                              │
                              ▼
                     createRunBudget({ caps, now, startedAtMs, spent })
                              │  charge(kind, units) — ALL OR NOTHING
                              ▼
                  null  ─or─  RunCapHalt { kind, limit, source, used, refused }
```

`executeFrom` resolves ONE budget per run segment and charges against it:
`RUNTIME_MS` and `STEPS` before each step, `TOOL_CALLS` before each READ /
PROPOSE tool call, `PROPOSALS` per ITEM before a propose call, `TOKENS` after
each step's context commit. A halt returns through `haltRunAtCap`.

### Why the composition is a minimum, and why a tie names the ENGINE

Two ceilings exist and can disagree. The effective cap is the MINIMUM — the same
rule `resolveAutonomyCeiling` states ("a MINIMUM over independent narrowing
terms, so no term can widen") and the rule the policy card is already built on.
Taking the maximum would let a card WIDEN a global ceiling, making the engine's
number a suggestion; taking the card alone would let anyone with edit rights on
one card raise this deployment's ceiling.

A TIE resolves to `ENGINE`, and that is not cosmetic. `source` is what an
operator reads to decide what to widen. When card and engine agree at 50,
widening the card to 100 changes nothing — so naming the card would send
somebody to make an edit that cannot work.

### An agent with NO card gets the engine ceiling, never an absent one

`policy-card.ts` is explicit that an absent card contributes NO term, and it is
right: reading "no card" as "may do nothing" would make creating the register's
own governance artefact the thing that takes a working agent dark.

But "contributes no term" was being read as "there is no term". On the per-run
action axis there was no other one, so an agent WITH a card was bounded at, say,
25 calls per run and an agent WITHOUT a card was bounded at infinity. **Deleting
a card raised the ceiling** — the governance control being strictly worse than
not having it.

`resolveRunCaps(null)` now returns the ENGINE ceiling on every axis. The card
still only narrows, an absent card still refuses nothing on its own, and
deleting a card moves an agent from 25 to 50 rather than from 25 to unbounded.
Because the engine cap also clamps the TOP rung of `ACTION_CAP_LADDER` (1000),
an uncarded agent is never strictly more permissive than the most permissive
card this product can express.

### HALTING IS NOT TRUNCATION — the load-bearing property

`charge` is ALL-OR-NOTHING. A request for ten units against a budget with three
left is refused for all ten; it is never granted three.

The convenient alternative is the failure mode. A run that proposes 500 items
under a cap of 100 and is quietly given the first 100 produces a review queue
that LOOKS like the agent's considered output. Nobody chose that subset, and
nothing downstream can tell it apart from a run that meant to propose exactly
100 — the evidence that would say so is the evidence that was dropped.
`bounded-exec.ts` reaches the same conclusion about a tool's OUTPUT ("a
truncated tool output is worse than no output, because an agent cannot see the
difference"); this is that sentence about a run's WORK.

So a breach: refuses every unit, leaves the ledger unadvanced, marks the run
FAILED with a message that says the work stopped rather than shrank, emits
`agentic.run.cap.halt{cap,source}`, and writes a `WORKFLOW_RUN_CAP_HALTED` audit
row carrying `cap`, `capSource`, `limit`, `used`, `refused` and **`stepsNotRun`**
— the remaining work, visibly not-done rather than quietly gone.

### The boundary

A cap of N grants exactly N units; the unit that would make N+1 is refused. That
is the `+1 >` convention `evaluateCardReach` already uses for the card's own
per-run budget, so the engine budget and the card budget bind on the SAME call
rather than one call apart. `RUNTIME_MS` follows it too: at exactly N ms elapsed
the run is inside its budget, at N+1 it is not — which is the pre-existing
`Date.now() - start > WALL_CLOCK_MS` comparison, unchanged.

### The day window

Untouched, and deliberately so. A per-day budget needs a durable counter and a
window, and both already exist exactly once:
`AgentPolicyCard.actionsInWindow` plus `reserveDailyAction` / `utcDay` in
`policy-card-store.ts`, whose window rolls **inside the same UPDATE that
increments it** — so the daily reset is a property of the write rather than a
scheduled job, and there is nothing to run at midnight and nothing to fail to
run. `run-caps.ts` defines no second "day": a budget with two homes is two
budgets.

**A run in flight when the window rolls** therefore keeps its per-RUN budget
untouched (that budget is not windowed) and gets a fresh per-DAY allowance for
calls made after 00:00 UTC, because the reservation re-reads the window on every
call. A long run straddling midnight can spend against two days. That is the
deliberate reading: pinning the day at run start would let a run started at
23:59 spend tomorrow's budget as well, and would need a durable per-run day pin
to survive a resume. The window is UTC and not tenant-local for the reason the
column's own comment gives — a calendar day stored as a timestamp invites a
comparison that is right in exactly one timezone.

### One pre-existing defect fixed on the way

`resumeWorkflowRun` passed `Date.now()` as the run's start, so every resumed
segment got a **fresh wall clock**. The hour-long `WALL_CLOCK_MS` cap bounded a
SEGMENT, not a run: a workflow with two checkpoints could span three hours with
every segment reporting itself well inside the ceiling. It now passes
`run.startedAt.getTime()`. This is the same defect `actionsAlready` already
fixed for the action budget, on the axis where the wrong answer looks most like
the right one — a paused run genuinely is not spending anything.

The proposal budget is seeded the same way, from the append-only step ledger
(`proposedItemsSoFar`), so a run with three checkpoints does not get four
proposal budgets.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/run-caps.ts` | NEW. The five axes, the engine ceiling derived from `ENGINE_CAPS`, `resolveRunCaps` (strictest-wins composition), and the all-or-nothing `RunBudget` ledger with an injected clock. No server imports. |
| `src/app-layer/usecases/workflow-runs.ts` | Resolves one budget per run segment; charges every axis; `haltRunAtCap` marks the run and records the cap + the work not done; `recordRunCapUtilisation` on the completion path; the resume wall-clock fix. |
| `src/lib/observability/metrics.ts` | `agentic.run.cap.halt` counter (labels: cap, source) + `agentic.run.cap.utilisation` histogram, with the spike-annotation reading for each. |
| `tests/unit/agent-caps.test.ts` | NEW. The ledger boundary at all three positions per axis, the composition, all-or-nothing, and the engine behaviour end to end. |
| `tests/guardrails/agentic-engine-coverage.test.ts` | Its caps assertion pointed at three literal `ENGINE_CAPS.*` spellings inside the engine. Re-aimed at the declaration that derives them and at the halt path. |
| `tests/unit/workflow-context-integrity.test.ts` | Fake DB gains `workflowStep.findMany` and a `startedAt`, both now read by the engine. |
| `tests/guards/no-raw-prompt-logging.test.ts` | `MEASURED_HOLES` / `MEASURED_SINKS` re-measured for the new audit sink. |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | Two baselines re-seated — see Decisions. |

## Decisions

- **No schema change, and it is a constraint of this run rather than a
  preference.** Three sibling branches build on the same checkout and the
  generated Prisma client lives in a SHARED `node_modules`; regenerating it from
  a schema only one branch has breaks the other three. (Observed live: one
  suite failed here with an `EXPIRED` enum member that exists in no schema on
  this branch, and passed again minutes later when the client was regenerated
  back.) A `WorkflowRun.haltedByCap` column would make the cap queryable rather
  than a string; it is a one-column follow-up, not a redesign.
- **The run stays `FAILED` rather than gaining a `HALTED` status.** Adding an
  enum value is safe to WRITE under a rolling deploy and unsafe to READ: a
  container still on the old build cannot deserialise a status its client does
  not know, and would take the whole run list down for the duration of the
  rollout. The cap is carried by a distinct audit ACTION, structured details and
  the error message — all three of which an old build reads as strings.
- **`haltRunAtCap` is separate from `failRun`, and the separation is the
  requirement.** `failRun` says a step went wrong. A cap halt says nothing went
  wrong at all: the run was working as designed and was stopped because it
  reached a ceiling somebody set. Those are different operator actions, and an
  `errorMessage` that reads like a tool error sends people to debug the workflow.
- **Tokens are charged AFTER the context commit.** The step has already run and
  its output is real; charging before the commit and halting would throw away
  work that was actually done — a silent loss wearing a cap's clothes.
- **`PROPOSALS` is an axis of its own, not a consequence of `TOOL_CALLS`.** One
  `propose_controls` call is one call and can carry five hundred items, so a
  card capping an agent at a single action per run bounds proposal flooding not
  at all.
- **`TOOL_CALLS` equals `MAX_STEPS` rather than exceeding it.** A workflow step
  makes at most one tool call, so a tool-call ceiling above the step ceiling
  could never bind, and a number that can never bind is not a bound.
- **Two assertion-reach baselines were re-seated, and they were already red on
  the base commit.** Measured on a pristine checkout with no local change:
  `AMBIGUOUS_NEEDLE_BASELINE` 1462 against a live 1460, and
  `HIGHLY_AMBIGUOUS_NEEDLE_BASELINE` 251 against 250. With `DRIFT_ALLOWANCE` at
  0 that is exactly the headroom the sentinel exists to refuse. No cause is
  attributed: the improvement arrived with somebody else's merge, and inventing
  a story would be worse than recording that the number was measured.

## What this does NOT reach

**An UNCARDED agent still has no durable per-DAY counter.** The counter lives on
`AgentPolicyCard.actionsInWindow`, and an agent with no card has no such row.
Its per-RUN spending is now bounded by the engine on all five axes, but the
number of runs it may start in a day is bounded only by whoever starts them.

Three ways to close it, and each costs something this change deliberately did
not spend:

- a new counter table — a migration, an RLS policy triple and an
  `ISOLATION_TESTED` entry, against a shared Prisma client;
- moving the counter to `RegisteredAgent` — the same migration problem, plus it
  relocates a budget that other code already reads;
- counting uncarded agents on a card row — there isn't one, and creating one is
  creating a card.

The honest fourth option — refuse every call from an uncarded agent — is the
composition failure this subsystem has already written down three times, and is
not on the table.
