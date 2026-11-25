# 2026-11-25 — A person's resume of a paused Managed Agents run reconnects to its session (#5854)

**Commit:** `fix(agents): …` (see the branch `fix/fix-5854-ma-resume-reconnect`)

Owner decision of 2026-11-25 (the second that day), recorded on #5854:

> A run that was PAUSED (for example by a SIGTERM drain) and is resumed by a
> person ALSO reconnects to the session its paused segment created, instead of
> starting a new session. The checks are the same: drift; refuse a gone,
> terminated or stopped session; re-apply recorded guard verdicts; answer open
> calls as kept / `TOOL_CALL_OUTCOME_UNKNOWN` / `TOOL_CALL_NOT_RUN`. This
> matches how the Tool Runner continues a paused run.

This reverses decision 2 of `2026-11-25-fix-5854-ma-reattach.md` ("a new
segment, such as a person's resume, never reconnects to an earlier segment's
session") for a PAUSED run's resume only, so the race with the reconciliation
is argued again below.

## Design

```
SIGTERM drain (pauseInFlightRuns)       RUNNING → PAUSED, lease → NULL, updatedAt = pause
    engine's next check: isRunAborted (lease lost)
        lostRunDestination:  holder another token     → SUCCESSOR  ┐ handed on:
                             NULL, not ABORTED/FAILED → CONTINUES  ┘ no answer, interrupt or delete
                             NULL, ABORTED/FAILED     → STOPPED      stop and settle, as before
    settleSession asks it again before it touches the session

resumeWorkflowRun (PAUSED)               claim PAUSED → RUNNING; job carries pausedAt = updatedAt before the claim
executeQueuedWorkflowRun (SESSION engine, pausedAt valid)
    anchorSegment(…, { continuePaused })  new key, the PAUSED segment's segmentFromSeq
    ctx.runSegmentFromSeq      = that start
    ctx.runSegmentContinuesPause = segment − pausedAt < 23 h ? IN_TIME : TOO_LATE
executeManagedAgentsRun
    readSegmentLedger(start)               the paused segment's newest own session
        open, TOO_LATE   → settle it, FAILED managed_agents_reconnect_resumed_too_late
        open, IN_TIME    → RECONNECT (#5943's path, unchanged)
        settled          → FAILED managed_agents_reconnect_session_settled_while_paused
        none             → create one, as before

reconcileLostSessionDeletes, abandoned pass
    candidates = session steps in the 7-day lookback
               ∪ every session of a run PAUSED ≥ 24 h, or ENDED in the lookback but started before it
    held       = RUNNING, or PAUSED < 24 h ago and the agent not RETIRED   (never settled)

abortWorkflowRun of a run that is not RUNNING
    after the commit: settleAbortedRunSessions             open sessions, by recorded id, 15 s
        kept connection → SESSION_KEPT; deleted → SESSION_DELETED; else SESSION_DELETE_FAILED
```

### The race, argued again

The resume and the reconciliation decide from the same fact, the instant the
run was paused (its row's `updatedAt`, which the drain's `updateMany` moved and
which nothing else writes while the run is PAUSED: a lease renewal is raw SQL
and every engine write is fenced on the lease the drain cleared).

- The pass settles a session only when its read sees the run PAUSED for at
  least `PAUSED_SESSION_HOLD_MS` (24 h).
- A resume reconnects only when its claim came less than
  `PAUSED_SESSION_RESUME_WINDOW_MS` (23 h) after the pause, measured from two
  values in its own payload (the pause and the claim instant `segment`), so
  every retry of the resumed segment decides alike.

A reconnecting resume claimed at `c < p + 23h`. A pass whose read came before
the claim saw the run PAUSED for less than `c − p < 23h`, so it held the
session; a pass whose read came after it saw the run RUNNING (held) or ended
(its own engine settled the session, or, dead, the session is abandoned and
the pass's to settle). The hour between the two thresholds absorbs clock skew
between hosts and the seconds a pass spends between its read and its delete.
A resume claimed in that hour or after it does not continue: it settles the
session itself and fails by name. So a session one of them continues is never
one the other is deleting.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/run-lease.ts` | `lostRunDestination` replaces `runLeaseTakenOver`: SUCCESSOR, CONTINUES or STOPPED |
| `src/lib/agentic/managed-agents/execute.ts` | a drain's pause is a handover; the too-late resume; the paused-run refusal sentences |
| `src/lib/agentic/managed-agents/session-ledger.ts` | `PAUSED_SESSION_HOLD_MS` (24 h) and `PAUSED_SESSION_RESUME_WINDOW_MS` (23 h) |
| `src/lib/agentic/drivers/checkpoint-store.ts` | `anchorSegment`'s `continuePaused`: a resume takes over the paused segment's start |
| `src/app-layer/types.ts` | `RequestContext.runSegmentContinuesPause` |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts`, `agent-run-execute.ts` | `pausedAt` in the job, forwarded |
| `src/app-layer/usecases/workflow-runs.ts` | the resume puts `pausedAt` in the job; the worker anchors a continuation; an Abort of a run no worker drives settles its session |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | the held runs include a PAUSED run inside the hold; long-lived runs' sessions are read whatever their age; `settleAbortedRunSessions` |

## Decisions

- **The resumed segment finds the session through the segment anchor.** The
  pause keeps the run's checkpoint row, anchor included, so at the resume the
  row still names the paused segment's start (`segmentFromSeq`). The new
  segment is anchored at that start under its own key, so the engine reads the
  paused segment's part of the ledger as its own and the newest session it
  created there is the ONE session: exactly the rule a retry uses, with no new
  lookup. "The newest open session in the run's whole ledger" was rejected: it
  could pick an earlier segment's session whose settle was lost, and it would
  need a second rule beside the retry's. The anchor's start also survives a
  second pause and resume of the same session, and a retry of the resumed
  segment finds the same start under its own key.
- **The signal is the pause's instant, in the job.** The worker cannot read
  the run's earlier status (the resume's claim made it RUNNING), and only the
  resume knows the run was PAUSED rather than AWAITING_APPROVAL. A run resumed
  from AWAITING_APPROVAL (a checkpoint, a guard hold) never continues: its
  session was settled when it parked. A job without `pausedAt` (an older
  build's) starts a new session, as before.
- **The drain no longer stops the session.** Before this, the drain's cleared
  lease read as an Abort: the engine answered the open calls "stopped", sent an
  interrupt (which a later reconnect would refuse as a stopped session) and
  deleted the session, and the ledger recorded none of it (the writes were
  fenced). Now a lease cleared to nobody on a run that is neither ABORTED nor
  FAILED is a handover. The other statuses that can follow a lost lease
  (RUNNING after a resume's claim, COMPLETED or AWAITING_APPROVAL written by the
  continuation) are handovers too: the session is the continuation's.
- **24 hours, from the pause.** A rolling deploy at any hour leaves the next
  working day to notice and resume, and the reconciliation runs once a day, so
  a session nobody resumes is gone at most about two days after the pause.
  Measured from the pause, not from the session's creation, because a resume
  carries a session across segments and a second pause would otherwise find
  its session already past the bound. A source constant, not a tenant setting.
- **Decision 4 still holds: every session is deleted eventually** (or kept by
  the customer's choice, which only the purge, a connection removal or an
  erasure ends). A paused run's session is settled by the run's own settle
  after a resume, by an Abort, by a too-late resume, or by the reconciliation
  once the hold passes. The lookback (7 days of session steps) could no longer
  see every open session, since one carried across resumes can be older, so
  the pass also reads, by the run's own state, every session of a run PAUSED
  past the hold and of a run that ended within the lookback but started before
  it. A hosted session (Step 6b) is never kept, so it is always deleted.
- **The kill switch does not reach a PAUSED run's session.** No engine executes
  a PAUSED run, and the kill is read where a run executes. A resume reads the
  kill before it reads its ledger and settles the run; the session is then the
  next reconciliation pass's (the run has ended and the session is past the
  abandon age). An Abort deletes it at once, and the hold bounds it otherwise.
  Deleting at the kill would need the kill route to reach every paused run's
  workspace, a provider call from a route that today makes none.
- **A retirement settles a PAUSED run's session at the next pass.** The
  cascade settles only the runs parked on a proposal it expires, and makes no
  provider call; a retired agent's PAUSED run can never be resumed
  (`resume_agent_no_longer_in_service`), so the reconciliation does not hold
  it: a PAUSED run whose agent is RETIRED is settled whatever the hold says.
  The run itself stays PAUSED, as before.
- **An Abort settles the session after its transaction commits**, through the
  clean-up's own `deleteSession` (read first, so a running session is left
  running), under a 15-second deadline. What it cannot finish is recorded
  `SESSION_DELETE_FAILED` with the outcome, so the failed-delete retry, which
  reads no lookback, takes it. A run of any other engine costs one ledger read.
- **A call that finished as the drain landed is answered
  `TOOL_CALL_OUTCOME_UNKNOWN`.** Its result reaches the checkpoint through a
  write fenced on the lease, which the drain has cleared, so it is not kept. A
  call whose result was kept before the drain is sent as kept. Widening the
  fence to admit writes on a PAUSED run was rejected: the fence is what stops a
  worker that lost its run from writing anything.

## Not done

- **A paused run stays PAUSED after its session is settled.** The pass settles
  the session, never the run; a later resume fails by name. Settling the run
  from the reconciliation would give it a writer of `WorkflowRun.status` it
  does not have.
- **The kill switch leaves a paused session to the next pass after a resume,
  or to the hold** (above).
