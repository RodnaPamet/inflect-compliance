# 2026-09-26 — external-write mode ladder (#2861, slice one)

**Commit:** `<pending> feat(agentic): the mode ladder for agent-driven external writes`

## Design

#2861 asks for a per-external-system mode ladder governing agent-driven writes
to a customer's third-party system. This slice lands **the control and nothing
else**, on purpose.

There is no external write path in this build. Every tool
`resolveExternalReadTools` hands the funnel is an `McpReadTool`; #2859 gave the
agent outbound READ reach and #2860 gave it tenant-approved parameters. So this
module gates nothing today, which is the point: #2241's lesson is what a rung
costs when it arrives *after* the authority it governs. Landing the ladder first
means the write path cannot be born ungated — it has to ask, and the default
answer is `DISABLED`.

    DISABLED  →  DRY_RUN  →  PROPOSE_ONLY  →  AUTOMATIC
                 records      routes to a      dispatches
                 intent       human queue      unattended

## Owner decisions this encodes (2026-09-26)

Three questions were put to the owner; all three answers are load-bearing.

1. **Both modes, with the tenant choosing** — reviewed writes *and* unattended
   writes must both be reachable. Encoded as two distinct terminal rungs rather
   than a flag, so the choice is a ladder position with a dwell in front of it.
2. **Read prior state first; refuse the write if it cannot be read.** Not in
   this slice (there is no write to precede), recorded here because it
   constrains the dispatch design: the read is a precondition, and
   unreadability is a refusal rather than a warning.
3. **Implement now, hold the merge** until #2859 and #2860 have run in
   production, per the issue's own "Depends on" section.

## Why four rungs, when the identity ladder has three

`src/lib/identity/write-ladder.ts` is `DISABLED → DRY_RUN → AUTOMATIC`. PROPOSE
sat between the last two and was deleted in #2241, so adding a propose rung back
needs an argument rather than a precedent.

The argument is that **#2241 removed a rung that enforced nothing.** In its own
words: seven days bought a move to a rung that refused every candidate, and the
move that actually granted unattended writes was free. `PROPOSE_ONLY` here is the
opposite shape — `AgentProposal` exists, `approveAgentProposal` is a privileged
human action, and it re-checks a `baseDigest` fingerprint at approve time and
refuses an approval whose fingerprint has moved. A connection at `PROPOSE_ONLY`
genuinely cannot write unattended.

It is also a **terminal** rung rather than a waypoint. A tenant that wants every
external write reviewed stops there and is finished. That is how the owner's
"tenant chooses" requirement is satisfied: stopping is choosing.

### The sibling arrangement, considered and rejected

The first design put `PROPOSE_ONLY` and `AUTOMATIC` side by side under `DRY_RUN`,
reasoning that a linear ladder makes `PROPOSE_ONLY` a mandatory waypoint — the
#2241 shape. That reading was wrong and the arrangement is strictly weaker: it
lets a connection reach unattended external writes **without a single human
approval ever having been exercised.**

What made #2241 harmful was not that a rung was mandatory. It was that the
mandatory rung enforced nothing *and* nothing gated the step above it, so the
dwell bought a move to a useless rung while the move that mattered was free.
Fix the second half and a mandatory rung becomes a feature: dwelling at
`PROPOSE_ONLY` means watching real approvals, which is the observation a dwell
exists to produce. Linear ordering with a gated final step keeps the choice and
keeps the evidence.

`refusalForMove` asserts this as a property — `DRY_RUN → AUTOMATIC` is refused
at 0, 7, 365 and 10,000 days with unlimited evidence.

## Evidence, not just elapsed time

The dwell copies the identity gate *including* the refinement #2843 finding 31
added to it: elapsed days alone treats a week in which nothing happened as a
quiet week, when it is actually a path that never fired. So each rung that can
be widened off and produces something must show its work:

| rung | evidence required to widen off it |
| --- | --- |
| `DISABLED` | none — it produces nothing by construction |
| `DRY_RUN` | recorded intents; zero means the agent never reached the write seam |
| `PROPOSE_ONLY` | approved proposals — **this is the #2241 answer**, the rung below `AUTOMATIC` must show humans actually reviewed external writes |

`evidenceInWindow` is optional and `undefined` is NOT zero: it produces its own
refusal, because "we could not look" and "we looked and found nothing" are
different answers and only one of them is evidence. Evidence is checked *before*
the day count, so an operator who waited the week and ran nothing is told the
useful thing rather than sent away to wait again.

A consequence worth stating: until the dispatch ships, nothing records intents,
so a connection can be armed to `DRY_RUN` and **cannot climb further.** That is
the ladder working, not a gap.

## Files

| file | role |
| --- | --- |
| `src/lib/integrations/external-write-ladder.ts` | the ladder: rungs, coercion at the read boundary, the widen gate |
| `tests/unit/external-write-ladder.test.ts` | 31 assertions, weighted toward refusals |

## Decisions

- **Narrowing is never gated.** `refusalForMove` returns `null` for any move
  down, with no dwell and no evidence, even with a null `modeSince`. An operator
  revoking an authority mid-incident must never be told to wait; this is what
  makes the ladder safe to climb at all.
- **`coerceStoredMode` fails CLOSED to `DISABLED`**, including for
  `null`/`undefined`. The failure direction is the whole reason it exists:
  `isAboveClamp` sorts an unknown mode to -1, which reads as *not above the
  clamp* — permitted. A row this build cannot understand must not be treated as
  the widest authority the caller allows. Absence is a real "off", not a value
  to guess at.
- **`RETIRED_MODES` ships empty rather than omitted.** Postgres cannot drop an
  enum value without recreating the type, and an `ALTER TYPE` mid-rolling-deploy
  fails still-running old containers with SQLSTATE 42704 — the hazard the
  identity ladder documents at length. A retired rung *will* survive in the
  column, so the place that translates it should exist before it is needed
  rather than be invented under pressure by whoever retires the first rung. It
  uses `hasOwnProperty.call`, never `in`: `in` walks the prototype chain, so
  `constructor` and `__proto__` would "match" and hand back a function as a
  write mode.
- **The index is the ordering**, and the mode union is derived from the `const`
  tuple. Retiring a rung is then a compile error at every site naming it rather
  than a value that quietly sorts to -1.
- **No storage in this slice.** Adding `externalWriteMode` columns now would be
  a migration for a mechanism with no reader and no writer — a half-built
  control, which is the failure mode this repo files under "wired is not
  delivered". Storage lands with the dispatch that reads it.
- **Refusals are strings, not booleans.** Every one is shown to an operator
  mid-decision, and "no" without a reason invites them to conclude the gate is
  stale. The identity policy learned this the hard way in #2843 finding 31.

## Risk assessment and rollback

STANDARD: one new module with no importer, one new test file, no schema change,
no migration, no route, no behaviour change to any existing path. The build
before and after this commit behave identically.

Rollback is deleting the two files. Nothing imports them, so no call site
breaks and no data migrates.

## Not in this slice

- storage for the mode, and the OWNER-gated route that sets it
- the dispatch branch that reads it, and the external write tools it governs
- read-prior-state, per owner decision 2 above
- the Art 12 / Art 14 record for an autonomous change to a third-party system
- rollback semantics, which the issue notes JML gets from its journal and an
  arbitrary external config change may not have at all
