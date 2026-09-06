# 2026-09-06 — agent behavioural circuit breaker (anomaly, not volume)

**Commit:** `<pending> feat(agentic): trip a circuit breaker on behavioural anomaly, not only volume`

## Design

The action caps already on an `AgentPolicyCardVersion` answer *is this agent
doing too MUCH*. They cannot answer *is this agent doing something DIFFERENT*,
which is the OWASP ASI10 rogue-agent question — an agent that has read framework
status every night for a month and starts calling propose tools has exceeded no
budget and never will. A volume threshold set high enough to be quiet misses it
entirely.

```
    MCP tool call
         │
    authorizeToolCall
         ├─ 1. audience
         ├─ 2. credential liveness
         ├─ 2b. CIRCUIT BREAKER ──► openBreakerGate(tenant, agent)
         │        OPEN → AUTHZ_DENIED (circuit_breaker_open) + 403
         ├─ 3..10 manifest / exposure / autonomy / card / scope / permission
         └─ 11. OBSERVE ──────────► recordAuthorizedCall(...)
                                        │
                     one INSERT … ON CONFLICT into AgentBehaviourWindow
                                        │
                     once per ACTIVE window: evaluateWindow(...)
                                        │
                     evaluateCircuitBreaker(BreakerInput) → BreakerVerdict
                                        │
                            TRIP → latch AgentCircuitBreaker OPEN
```

**Three signals**, each carrying something the other two cannot see.
`PROPOSAL_RATE` is the flood. `REJECTION_RATE` is the review queue — the only
observer that can judge the agent's output *quality*, so a step change in what
humans reject is the queue telling you the agent changed. `TOOL_MIX` is the
distribution over capability CLASS, and it is the low-volume arm: one propose
call from an agent that has only ever read is a bigger fact than a hundred extra
reads.

**The judgement is a pure function.** `evaluateCircuitBreaker` reads no clock, no
database and no randomness — `now` is a field of its argument. A control whose
verdict depends on when it happened to run cannot be re-derived during the review
that follows a trip, and *"would it have tripped on yesterday's numbers"* is the
first question anybody asks.

**Detection is lazy, enforcement is per call.** There is no scheduled job. The
latch column `lastEvaluatedWindow` records the window last judged, and the
boundary judges when the agent's current window is not that one — once per active
window per agent, driven by the agent's own traffic. The *refusal* is on every
call, so an OPEN breaker stops a run already in flight rather than only the next
dispatch.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/circuit-breaker.ts` | The pure evaluator: vocabulary, thresholds, robust statistics, `evaluateCircuitBreaker`. No I/O, no clock. |
| `src/lib/agentic/circuit-breaker-store.ts` | The only place the breaker touches Prisma: the per-call upsert, the baseline load, the rejection counts, applying a verdict to the latch. |
| `src/lib/mcp/authorize.ts` | Step 2b (the gate) and step 11 (the observation). |
| `src/app-layer/usecases/agent-circuit-breaker.ts` | The operator read, and `closeAgentCircuitBreaker` — the only thing that un-trips an agent. |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/circuit-breaker/route.ts` | `GET` the latch + ledger + thresholds; `POST` to close, gated by `admin.agent_registry`. |
| `src/lib/observability/integration-metrics.ts` | Four counters with their alert annotations — verdict (the denominator), trip, refusal, close. |
| `prisma/schema/agentic.prisma` | `AgentBehaviourWindow` (the ledger) and `AgentCircuitBreaker` (the latch). |
| `prisma/migrations/20260906120000_agent_circuit_breaker/migration.sql` | Both tables, the RLS policy triple + FORCE on each, and four CHECK constraints. |
| `tests/unit/agent-circuit-breaker.test.ts` | The evaluator, on hand-written ledgers and a hand-written clock. |
| `tests/integration/agent-circuit-breaker-isolation.test.ts` | Two-tenant isolation, the concurrent-upsert property, and the latch end to end. |

## Decisions

**A baseline is refused out loud.** Below twelve complete windows or thirty
observations the verdict is `NO_BASELINE`, every signal reports `NOT_JUDGED` with
that shortfall as its basis, and the metric counts it under its own outcome
label. *"The breaker found nothing"* and *"the breaker declined to look"* are
different facts, and a control that reports them identically is reporting the
second as the first. The two shortfalls are named separately (`TOO_FEW_WINDOWS` /
`TOO_FEW_OBSERVATIONS`) because only one of them is fixed by waiting.

**Five suppressions, because false positives are what kill this control.** A
breaker that trips on legitimate change is switched off by the first operator it
inconveniences, and then protects nothing. (1) No verdict without a baseline.
(2) Median and MAD, never mean and standard deviation — one prior incident
inflates a mean enough to hide the next one and a standard deviation enough to
hide everything. (3) A rate trip needs an absolute delta *and* a multiple *and* a
robust z, all three: alone, the absolute one fires on every busy agent, the
multiple on every quiet one, and the z on any agent whose history is flat.
(4) Persistence — one anomalous window ARMS, two consecutive windows *sharing a
signal* trip. (5) A deliberate operator change advances `baselineEpoch` and the
agent re-learns rather than tripping.

**Persistence is per SIGNAL, not per window.** Two consecutive windows firing
different signals are two unrelated oddities; the claim worth stopping an agent
for is that the *same thing* is still true. The streak continues only when the
current window's firing set intersects the previous one's.

**A detector must not learn from the anomaly.** `AgentBehaviourWindow.anomalous`
is set on any window whose verdict fired, and `evaluateCircuitBreaker` drops those
rows before it computes anything. Without it the strongest signal here is also the
shortest-lived: the first propose call from a read-only agent makes `propose` a
class that agent has used, so `NOVEL_CAPABILITY_CLASS` would extinguish itself one
window after firing and the two-window rule could never be satisfied by it. The
flag lives on the observation rather than being applied by the caller, so a store
that hands over every row still behaves correctly — a filter the evaluator cannot
see is a filter nothing verifies.

**A novel TOOL NAME is evidence, never a cause.** It is the most tempting signal
available and the worst one: every routine grant produces one. Novel names ride in
the verdict so a trip is legible; only a novel capability CLASS trips.

**Only AUTHORIZED calls are recorded, and that is a security property.** Recording
refused calls would blend two populations, and worse would let a caller STEER ITS
OWN BASELINE with calls that never execute — spray reads that get refused, raise
the read baseline, dilute the distribution distance of a later propose burst.
Refusals are not lost; they have `AUTHZ_DENIED` rows and the policy-card refusal
counter.

**An empty hour is not a zero.** A window row exists only for an hour the agent
was observed in. An absent hour is ambiguous — idle agent, stopped worker,
sleeping tenant — and a baseline that reads every such hour as a hard zero drifts
toward zero and then trips on the first ordinary hour. So the rate judged is
*calls per ACTIVE window*, which is a claim the rows can support. It also means
the window judged is the newest complete *active* window, not the hour before this
one: picking the fixed hour would have left a nightly agent's previous hour always
empty, and the design inert for exactly the agents whose single daily burst is
hardest to read.

**Rejections are attributed by REVIEW time.** *"The queue is suddenly rejecting
this agent's work"* is an event that happens when a human clicks reject;
attributing it to the hour the proposal was written would make the signal lag by
however long the queue is, which on a quiet tenant is unbounded. `QUARANTINED` is
neither reviewed nor rejected — that is the output guard's verdict, not a human's,
and counting it would let one signal appear twice.

**Recovery is human, audited, and the reason is load-bearing.** No half-open probe
and no timeout: both are auto-recovery, and an agent that has gone rogue can wait
one out. `closeAgentCircuitBreaker` is gated by `admin.agent_registry` at the
route (so a denial writes a hash-chained `AUTHZ_DENIED` row and the 403 never
echoes the key) and the database CHECK refuses a closed row with no actor and no
reason. `ACCEPTED_NEW_BASELINE` discards the history and the agent re-learns;
`RESOLVED` keeps it, because that is what the agent should return to. Collapsing
them would silently adopt rogue behaviour as normal — which is why
`agentic.circuit_breaker.close` is labelled by reason: a deployment where every
trip is answered with *"that's fine now"* has a detector calibrated to fire on
ordinary work, and that is the shape this control dies of.

**A tripped breaker halts everything, reads included.** A half-stopped agent that
may still read is still reading a tenant's whole compliance posture on its own
initiative, which is the exfiltration half of the rogue-agent case.

**The refusal message names the state, never the signal.** What tripped a breaker
is a fact about how the detector reads this agent, and handing it to the caller
hands an attacker the shape of the threshold to stay under. It is on the latch row
and in the audit entry, where the operator reads it.

**Why `2b` rather than a renumbering.** The gate belongs with liveness: both ask
*may this agent be running at all, right now*, both are agent-level rather than
call-level, and both change their answer DURING a run.

**No new Postgres enum.** `state`, `verdict` and `closeReason` are TEXT with CHECK
constraints, for the reason the `@@map("WorkItem*")` pins record: an `ALTER TYPE`
mid-rolling-deploy makes still-running old containers fail with SQLSTATE 42704,
and this vocabulary is one a follow-up is likely to widen.
