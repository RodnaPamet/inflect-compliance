# 2026-09-23 — A Flue guard verdict reaches the controls built for it

**Commit:** `<sha>` fix(agentic): a guard block settles as a guard block, and the breaker can see it

Phase 1 audit, points **4c** and **4d/4f**. Two findings, one defect seen from
both ends: a guard outcome on the Flue engine produced nothing any surrounding
control could read.

## 4c — the run status

`review.check` leaves by **throwing** on both of its refusal paths. So every
block and every flag arrived in `executeFlueRun`'s catch and was settled
`flue_run_failed: <the throw's message>` — a control outcome reported as a
crash. An operator reading that row goes and debugs a workflow that worked
perfectly.

And `policy.ts` states the FLAGGED contract as *"allow, but force human review;
NEVER auto-commit"*. Nothing in this engine could produce `AWAITING_APPROVAL`
at all.

`haltRunAtGuard` is the arm, and it is a sibling of `haltRunAtCap` rather than
of `failRun` for the reason that function's own docstring gives: `failRun` says
a step went wrong, and nothing went wrong here.

| verdict | status | why |
|---|---|---|
| `QUARANTINED` | `ABORTED` | nothing to approve — the content was refused and never moved |
| `FLAGGED` | `AWAITING_APPROVAL` | the contract's own words, and `resumeWorkflowRun` already accepts it |

**Both exit paths consult it**, which is the half that is easy to get wrong.
The latch refuses every call after the first flag, so a flagged run *usually*
leaves by throwing — but a flag on the LAST call lets the dispatch finish
tidily, and a fix applied only to the catch would report that run `COMPLETED`.

**The cap still wins.** The guard arm sits *below* the `latch.halt` check on
both paths: a run that hit the cap and was also flagged is a run that hit the
cap, and relabelling it would hide a ceiling somebody set.

## 4d/4f — the circuit breaker

`latchOnGuardBlock` counted `AgentProposal` rows with
`guardVerdict: 'QUARANTINED'`. The static driver's guard fires on a proposal,
so that was the whole story for it.

The Flue guard fires in the tool sandwich **before the funnel** — which is the
entire point of putting it there — so a blocked call queues no proposal *and*
never reaches `authorize.ts`, where `recordAuthorizedCall` writes the per-call
ledger. A Flue agent was therefore invisible on **both** of this breaker's
inputs: the control that exists to stop a rogue agent could not see the engine
most able to be one.

The step ledger is the second population. A Flue block already records a
`WorkflowStep` with the same `QUARANTINED` verdict, and the run it belongs to
carries the `agentId` the breaker is about.

## Decisions

- **No new `WorkflowRunStatus` value.** `haltRunAtCap` carries the argument:
  adding an enum member is safe to WRITE under a rolling deploy and unsafe to
  READ, because a container still on the old build cannot deserialise a status
  its client does not know and takes the whole run list down for the rollout.
  `ABORTED` and `AWAITING_APPROVAL` both already ship and are already read.
- **`completedAt` on the abort arm only.** A run awaiting a human is not
  finished, and the reaper leaves `AWAITING_APPROVAL` alone however old it is
  precisely because someone is expected to come back to it.
- **The worst verdict is folded where it happens, not read back.** `seen` is
  consumed — `takeVerdict` removes each entry as its step is recorded — so by
  settle time it is empty and cannot answer "did a guard fire during this run".
  A fix that read it back would be green on a one-call run and wrong on every
  other.
- **The settle message carries rule IDS, never the matched content.** The text
  a scanner matched is the thing the guard exists to contain; copying it into an
  `errorMessage` an operator surface renders would be the leak, in the row that
  exists to record the refusal.
- **The breaker is told only on a BLOCK.** Its threshold is three *blocks*;
  counting flags would trip it on traffic the policy explicitly allows subject
  to review.
- **The breaker call is once per run, and the COUNT keeps the granularity.**
  A blocked run aborts at the first block, so per-run and per-block are the same
  thing in practice — and the count reads the step ledger, which records every
  block regardless.
- **It windows on the step's own `at`**, not the run's `startedAt`: a run that
  began before the window and was blocked inside it was blocked inside it.
