# 2026-09-21 — Closing the Art 14 loop on agentic decisions

**Commit:** `<sha>` feat(agentic): stamp the human-oversight outcome on agentic decision-log rows

Phase 1, point 4: *"One decision-log row per model call — EU AI Act **Art 12**;
stamp `humanOutcome` on review — **Art 14**, closed loop."*

The Art 12 half was already built. The Art 14 half was not, and this closes it.

## What was already there, and what was missing

`createAgentProposal` has written the Art 12 record since the agentic work
landed — an input digest, a bounded summary, the guard verdict, in the same
transaction as the proposal it describes.

`recordDecisionOutcome` — the Art 14 stamp — also already existed. It was called
from `risk-suggestions.ts` and **from nowhere else**. So every agentic decision
was created at `humanOutcome: PENDING` and nothing ever moved it: a register
that recorded what an agent proposed and never what a human decided about it.

Approve and reject now stamp it.

| File | Role |
|---|---|
| `src/app-layer/ai/decision-log/index.ts` | `recordDecisionOutcomeForDigest` — the same stamp, keyed by digest |
| `src/app-layer/usecases/agent-proposals.ts` | the two call sites |
| `prisma/schema/automation.prisma` + migration | `@@index([tenantId, inputDigest])` |

## Decisions

### The key is the digest, not the session — and this is the whole design

`recordDecisionOutcome` keys on `sessionRef`. That is right for the suggestion
features, which generate a session and carry its id. The agentic path has no
session: `createAgentProposal` writes `sessionRef: input.proposedBySessionRef ??
null` and that input is optional, so for an ordinary agent proposal **the key is
NULL**.

A session-keyed stamp there matches nothing. `updateMany` returns `count: 0`,
raises no error, and the loop looks closed while every agentic decision stays
PENDING for ever. **A silent zero is the worst available outcome for a
record-keeping control** — it is indistinguishable, at every surface, from one
that worked.

`inputDigest` is always present on that path, and the join is not new: the
proposal usecase already documents that `AiDecisionLog.inputDigest` and
`AgentProposal.guardInputDigest` are the same `sha256:` string, hashed from the
same object, "so the two records join". This uses that join for the purpose it
was written for.

### The stamp goes at the APPLIED return, not the other one

`approveAgentProposal` has two exits. One records a **signature** on a proposal
that still needs a second approver and returns `AWAITING_APPROVAL`; the other
applies the proposal. Only the second is a human outcome.

Stamping at the first would record "a human decided" the moment one of two
reviewers signed — the automation-bias failure `wasApplied` exists to prevent,
written into the permanent record. There is a test for exactly this: a
first-of-two signature must leave the row PENDING.

### `EDITED` is carried, not flattened

`ApproveResult.status` is already `'ACCEPTED' | 'EDITED'`, which is exactly the
`AiDecisionOutcome` vocabulary, so the value passes straight through. "A human
accepted what the agent proposed" and "a human had to change it first" are
different facts about oversight, and the register keeps both.

### Best-effort on approve, in-transaction on reject

Approve stamps after the proposal is applied, with a `.catch` — a logging
failure must not undo an applied proposal. Reject stamps inside the same
transaction as the status write, because there is nothing to undo and the
alternative is a register saying a human is still deciding something they have
already refused.

That asymmetry makes the returned count the only signal on the approve path,
which is why every test asserts it.

### An index, because the table grows per AI call

`AiDecisionLog` gains a row per AI-feature invocation. Without
`[tenantId, inputDigest]` the stamp degrades to a scan of everything the tenant
has ever generated, on the path a reviewer is waiting on — correctness-neutral,
latency-fatal, and invisible to every behavioural test. It mirrors the
`[tenantId, sessionRef]` index already there for the same query shape on the
other key.

## What was proved

Two layers, because a helper that works and a usecase that calls it correctly
are different claims.

**The helper** (8 tests, keyed on counts rather than on "it didn't throw"):

| mutation | result |
|---|---|
| key on `sessionRef` instead of `inputDigest` — the silent-zero bug | **5 of 8 red** |
| drop the tenant term | **1 red** (two tenants can share a digest; content hashes collide by design) |
| drop the `PENDING` filter | **1 red** (a decision must not be rewritten by a later one) |

**The wiring**, added to `proposal-review-tiering.test.ts` because only that
suite has the fixture producing a real proposal with a real guard digest and a
real Art 12 row behind it:

| mutation | result |
|---|---|
| remove the approve-path stamp | **2 red** |
| remove the reject-path stamp | **1 red** |

Those tests also pin the baseline — a fresh proposal reads `PENDING` — so a
later `ACCEPTED` cannot be a row that was simply written that way.

## What this does not do

The other half of point 4's bullet, *"one decision-log row per model call"*,
is not here and cannot be: there are no model calls. `workflow-runs.ts` is still
driven by hand-written step arrays whose SYNTHESIS steps are deterministic
template strings, and `DRIVER_IMPLEMENTED.flue` is `false`. What exists is a row
per agent PROPOSAL, which is the decision a human actually reviews — and that
row now carries its outcome.

When model calls exist, they get their own rows; the Art 14 mechanism they will
need is the one this change built.
