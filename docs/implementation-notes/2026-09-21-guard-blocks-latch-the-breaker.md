# 2026-09-21 — Repeated guard blocks stop the agent

**Commit:** `<sha>` feat(agentic): repeated guard blocks latch the existing circuit breaker

Phase 1, point 4: *"Repeated guard blocks latch the existing
`AgentCircuitBreaker` — not a new counter."*

## The gap

The output guard quarantines a proposal carrying injected content, and a bell
tells a human. **Nothing stopped the agent.** So an agent producing injected
content went on producing it, one quarantined row at a time, while the evidence
accumulated on a triage page with no inbound traffic.

An OPEN breaker is refused at `assertCircuitBreakerClosed` in
`src/lib/mcp/authorize.ts` — the gate every MCP tool call already passes through
— so latching it is what turns "we noticed" into "it stopped". That was verified
before anything was built: a control nothing consults is decoration.

## Decisions

### A guard block is a TRIP REASON, not a SIGNAL

Everything in `BREAKER_SIGNALS` is computed by `evaluateCircuitBreaker` as a
departure from the agent's **own** baseline — a robust z-score over a median and
a MAD, or a total-variation distance, each needing two windows of persistence.
That machinery needs a baseline to be a departure *from*.

Guard blocks have no such baseline and should not. The healthy rate is zero, and
a rate over a denominator of zero is not a rate — which this module already says
about the rejection signal's quiet windows. Worse, feeding blocks through the
statistical path would let the **first** block define the normal that later ones
are judged against, so an agent emitting malicious content steadily would look
steady.

So blocks latch **directly**, on a count, and appear in `trippedSignals` under
`GUARD_BLOCK`. `BREAKER_SIGNALS` stays exactly what the evaluator computes — a
test asserts a verdict carries a reading for every member, and adding one the
evaluator never reads would have broken it for the right reason. The new
`BREAKER_TRIP_REASONS` is the vocabulary a reader of `trippedSignals` actually
wants.

### Not a new counter, literally

The count comes from rows that already exist: `AgentProposal` carries
`guardVerdict` and an `agentId`, so "how many of this agent's proposals did the
guard quarantine this hour" is a question the schema can already answer. A
dedicated column would be a second record of the same fact, free to disagree
with the first — and the one that disagrees is always the one nothing reads.

### Three, in one window

One block is the guard **working**: the proposal is quarantined, the system did
its job, and stopping the agent would make every successful defence an outage —
which is how a control ends up switched off. Two inside an hour can still be one
payload retried. Three is a pattern, and the agent is better read as the vector
than as the victim.

The window is the breaker's own hour, deliberately not a lifetime total: an
agent that tripped the guard once a month for a year has not earned a stop, and
a count with no window would give it one.

### The same write `evaluateWindow` makes

Conditional on `state: 'CLOSED'`, so a human close landing between the count and
the update leaves `count: 0` and the latch shut; and the bell is gated on that
count rather than on the decision, because a notification announcing a stop that
did not happen is exactly the wrong thing to send about a stop control.

`notifyBreakerTrip` now takes the signals directly instead of a whole
`BreakerVerdict` — it only ever read `streakSignals` from one, and a guard-block
trip has no verdict to hand over. Constructing a synthetic one would put a
statistical judgement in the permanent record that was never computed.

### The database already required a stop to say why

`AgentCircuitBreaker_open_has_basis` — found while writing the fixture, not
before — is a CHECK requiring `trippedAt`, `trippedWindow` and a non-empty
`trippedSignals` whenever the state is OPEN. A stop that cannot say why it
stopped is not storable. The latch writes all three, so it satisfies a
constraint it did not know about; the test fixture originally did not, which is
how the constraint surfaced.

## What was proved

Four mutations against the integration suite:

| mutation | result |
|---|---|
| drop the window clause — blocks accrue for ever | **1 red** |
| drop the `guardVerdict` clause — clean proposals count | **1 red** |
| latch at 1 instead of the threshold — every defence an outage | **3 red** |
| drop the `state: 'CLOSED'` condition — re-latch an open breaker | **1 red** |

The sub-threshold case is asserted as hard as the threshold case, because "too
eager" is the failure that gets this control turned off, and it is the one a
suite full of positive assertions would never notice.

## What this does not do

It does not latch on guard blocks from the tool boundary — `runGuardedTool` in
the Flue adapter guards proposed tool arguments, but nothing executes it yet.
When the driver flips, that path calls the same `latchOnGuardBlock`; the
threshold, the window and the write are already the ones it will use.
