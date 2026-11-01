# 2026-11-01 — AI decision log: rows nobody will review

**Commit:** `fix(agents): the AI decision log stamps what nobody will review, and speaks in words (#4896)`

## Design

`AiDecisionLog.humanOutcome` is the Art 14 column. A row lands `PENDING` and a
person's review stamps it `ACCEPTED`, `EDITED` or `REJECTED`. Three kinds of row
were never stamped, because no step reviews them:

- an assistant answer, which goes straight to the person who asked;
- an outside tool call a run made, which has left the platform before the row is written;
- the model calls of a run that finishes without stopping for approval.

They stayed "awaiting review" for ever, and the evidence pack counted them as
"still pending review". The owner decided on 2026-11-01 that they are recorded
as "no human review" (`AUTONOMOUS`):

| Row | When it is stamped | By |
| --- | --- | --- |
| assistant answer | at insert | `assistant.ts` passes `humanOutcome: 'AUTONOMOUS'` |
| outside tool call | at insert | `recordExternalToolDecision` passes it |
| a run's model calls, run finished, no pending proposal | when the run settles | `settleRunDecisionLog` (`workflow-runs.ts`) |
| a run's model calls, run left proposals | when a person decides one | `approveAgentProposal` / `rejectAgentProposal` / bulk reject: the run's rows take that decision |
| …and its last pending proposal expires undecided | in the expiry sweep | `settleExpiredProposalRuns` (`agent-proposal-expiry.ts`) |

## Decisions

- **This relaxes a rule on purpose, for finished runs only.** `AiDecisionOutcome`
  still keeps `AUTONOMOUS` out of the human stamp. The only writers of
  `AUTONOMOUS` after insert are `recordRunDecisionsUnreviewed` and its batch twin,
  and neither takes an outcome. The DB trigger already allowed the move:
  `humanOutcome` may leave `PENDING` once.
- **A paused run is not settled.** `AWAITING_APPROVAL` and `PAUSED` stamp nothing;
  the resume and abort paths stamp the rows then.
- **The first decision on a run's proposals is the one its calls record.** The
  stamp is one-way, so a later decision on a sibling proposal changes nothing.
- **No backfill.** Rows written before this change keep `PENDING`. Stamping them
  would rewrite an append-only regulatory record retroactively, and that call is
  left to the owner.
- **`sessionRef` is never surfaced.** The page needs the run a row came from, so
  the read derives `runId` for run and tool rows. On other features `sessionRef`
  is a session key that can carry text (a composed request's template label).
