# 2026-09-23 — Art 14 closes for a Flue run, and what stays open

**Commit:** `<sha>` fix(agentic): close the Art 14 loop on the run a human reviews

Plan point 4 is "one decision-log row per model call — EU AI Act Art 12; stamp
`humanOutcome` on review — Art 14, closed loop." An audit graded the second
half ABSENT: nothing that stamps `humanOutcome` could address the rows the Flue
engine writes.

## The defect

`recordDecisionOutcomeForDigest` matches on `inputDigest`. All three of its
call sites (`agent-proposals.ts`, the approve and both reject paths) pass
`AgentProposal.guardInputDigest` — `computeProposalDigest({ kind, payload,
rationale })`, a digest over the PROPOSAL's content. The Flue row's
`inputDigest` is `computeInputDigest(message)`, over the dispatched run PROMPT.

Two `sha256:<hex>` strings of identical shape over different content. They
never match, `updateMany` reports `count: 0`, and nothing raises — so every
`feature: 'agentic-run:<key>'` row kept the schema default PENDING for ever and
rendered as "awaiting review" on `/agents/decisions`.

The sibling key was no help either: `recordDecisionOutcome` matches
`sessionRef`, and the Flue recorder passed none.

## What counts as review, and why

The reviewable event for a Flue model call is **the run**, and the human
actions on a run are `resumeWorkflowRun` and `abortWorkflowRun`.

A guard-FLAGGED run is settled `AWAITING_APPROVAL` by `haltRunAtGuard`
precisely so a person decides whether it may continue — `policy.ts` states
FLAGGED as "allow, but force human review; NEVER auto-commit". A resume is
that person saying yes; an abort is the operator kill-switch saying no. Both
are recorded against everything the run decided:

| human action | run state it acts on | outcome stamped |
| --- | --- | --- |
| `resumeWorkflowRun` | `AWAITING_APPROVAL` / `PAUSED` | `ACCEPTED` |
| `abortWorkflowRun` | any non-terminal run | `REJECTED` |

**The proposal digest was deliberately NOT used**, even though it is the key
already wired. Approving a proposal a run queued is a review of the proposal;
it is not a review of the model call that produced it. Writing one onto the
other's record puts a human decision about one artefact onto the permanent
record of a different one — which is worse than an honest PENDING, in a
register whose only value is that its entries are true.

## The key

`AiDecisionLog.sessionRef` — the column the schema already calls "the feedback
join key", and which this path left NULL. `recordModelDecision` now writes the
`WorkflowRun` id into it, and the two stampers query by that id.

An **identity, not a second digest**. A digest join is only as good as two
independent computations agreeing for ever, and that is exactly what failed
here. The run id is one value, written once and read once.

A run with checkpoints dispatches once per SEGMENT and so writes one row per
segment, each over its own prompt and therefore each with its own digest. They
share the run id, so one human decision stamps all of them — the person
resuming at step 7 is accepting what the run has done so far. The stamp stays
one-way (`humanOutcome: 'PENDING'` in the filter, plus the DB trigger), so an
abort after a resume cannot rewrite the acceptance.

No migration: `sessionRef` is an existing nullable `String` with an existing
`@@index([tenantId, sessionRef])`. Only its `///` doc comment changed.

## What does NOT close, stated plainly

Three of the four ways a Flue run can end have **no human action available at
all**, so their decision rows stay PENDING permanently. This is not a stamp
that was forgotten; it is a review that does not exist:

| terminal state | reached by | why nothing stamps it |
| --- | --- | --- |
| `COMPLETED` | a clean run | no route reviews a finished run. `abortWorkflowRun` refuses `COMPLETED`, and `/agents/decisions` is read-only |
| `ABORTED` (guard QUARANTINE) | `haltRunAtGuard` | a machine refusal. Stamping REJECTED would claim a person decided, which is the false-entry failure this whole change refuses |
| `FAILED` | a cap halt, or a throw | same: nobody looked |

**So PENDING on an `agentic-run:*` row means one of two different things** —
"a human has not reviewed this yet" (a run still parked at a checkpoint) or "no
human ever will" (the three rows above). The page cannot tell them apart, and
an assessor reading it should know that.

Closing the residual needs a review action on the decision log itself — a
route, an RBAC gate and a UI affordance — which is a feature, not a join fix,
and is deliberately out of scope here. The upgrade path if it is wanted: the
rows are already addressable by `sessionRef`, so a per-run "mark reviewed"
control reuses `recordDecisionOutcome` unchanged.

## A rendering bug found on the way

`AiHumanOutcome` has `EDITED`. `DecisionsClient`'s variant map and both message
catalogues spelled it `MODIFIED` — a value the column cannot hold — and were
missing the one it can. `approveAgentProposal` passes its own `'ACCEPTED' |
'EDITED'` status straight through, so EDITED rows were always writable; they
rendered with the neutral fallback badge and a `t()` key that resolved to
nothing, i.e. the dotted key path on screen.

`i18n-keys-resolve` could not see it and says so in its own docstring: it
follows literal `t('…')` keys only, and this lookup is a template literal —
"those keys are the ones a rendered test has to cover instead".

## Files

| File | Role |
|---|---|
| `src/lib/agentic/flue/model-decision.ts` | NEW — `recordModelDecision` + `aiSystemIdFor`, moved out of `execute.ts` unchanged except for the `runId` argument and `sessionRef` |
| `src/lib/agentic/flue/execute.ts` | imports the recorder, passes `runId` |
| `src/app-layer/usecases/workflow-runs.ts` | resume stamps ACCEPTED, abort stamps REJECTED — each in the same transaction as its own status write |
| `prisma/schema/automation.prisma` | `sessionRef` doc comment: a `RiskSuggestionSession` id OR a `WorkflowRun` id |
| `src/app/t/[tenantSlug]/(app)/agents/decisions/DecisionsClient.tsx` | `EDITED`, not `MODIFIED` |
| `messages/{en,bg}.json` | the same, both locales |

## Decisions

- **The recorder moved out of `execute.ts`, and that is what made the fix
  testable.** `execute.ts` imports `@flue/runtime` statically, so no CJS suite
  can load it — which is why its only existing test is structural. A structural
  test cannot answer "does the value the writer stores equal the value the
  stamper queries", because both sides look right in isolation; that is the
  precise shape of the defect being fixed. The new module's imports are all
  ordinary app-layer ones, so the integration suite runs the REAL writer against
  a real row. No logic moved with it.
- **The stamps sit inside the transactions that already existed**, for the
  reason `rejectAgentProposal` gives: a human decision recorded on the run but
  not on the decision log is a register saying a model call is still awaiting a
  review that has already happened. They are not `.catch`-swallowed — unlike the
  audit sink, this is the same database, so a failure that loses the stamp has
  already lost the status write too.
- **No driver branch.** A static run matches nothing and costs one indexed
  `updateMany`. Branching on the engine would put the engine's identity in a
  place that does not otherwise need to know it, and would be one more thing to
  get wrong when a third driver lands.
- **The integration suite walks a STATIC run.** The Flue engine needs an ESM
  runtime and a live model; the join key is the run id, which
  `recordModelDecision` takes as an argument, and resume/abort are one
  implementation for every engine — so nothing the claim depends on is
  simulated.
