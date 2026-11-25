# 2026-11-25 — A retried Managed Agents segment reconnects to its session (#5854)

**Commit:** `fix(agents): …` (see the branch `fix/fix-5854-ma-reattach`)

Owner decision of 2026-11-25, recorded on #5854:

> A retried, or lease-taken-over, Managed Agents segment that already made a
> tool call does NOT pause for a person. It RECONNECTS to the session it
> created at Anthropic and continues there. It reads the session's event
> history and answers each pending custom-tool call the way the Tool Runner
> continuation does: a kept result as kept, the call in flight
> `TOOL_CALL_OUTCOME_UNKNOWN`, a call not run `TOOL_CALL_NOT_RUN`. The
> reconciliation leaves such a session alone while its run is live.

This replaces the rule "a run never re-attaches to a session". Flue keeps the
`PAUSE_ON_RETRY` fallback of `2026-11-24-fix-5854-continue-conversation.md`,
because its runtime cannot resume.

## Design

```
executeQueuedWorkflowRun(…, { segment })
    segmentRecoveryOf('managed-agents') === 'SESSION'
        anchorSegment(segment, fromSeq)              (shared with Flue's pause)
        ctx.runSegmentFromSeq = retry ? anchor.segmentFromSeq : fromSeq
        (never paused)

executeManagedAgentsRun
    kill switch, run input, skills, offer, transfer gate   (unchanged)
    readSegmentLedger(runSegmentFromSeq)          BEFORE the start settles anything
        newest session the segment created (not one the start found unrecorded):
            none                 → create one, as every first attempt does
            settled (DELETED,
              KEPT, DELETE_FAILED) → FAILED managed_agents_reconnect_session_settled
            other connection     → FAILED managed_agents_reconnect_workspace_changed
            only CREATED         → RECONNECT
    settleUnrecordedSessions                                (unchanged)
    agent drift, environment drift                          (also on reconnect;
                                                             the session is deleted)
    RECONNECT:
        sessions.retrieve      404 → SESSION_DELETED(foundGone), FAILED _session_gone
                               terminated → delete, FAILED _session_terminated
                               other error → FAILED _session_unreadable
        readCheckpoint → openSessionCheckpoint(sessionId)   kept results, in-flight id
        verdicts any step of the session recorded → latched again (stop path)
        stream opened, then the history read: paged (100), bounded (5,000)
            interrupt in it         → FAILED _session_stopped
            events ≤ last span the ledger recorded → bookkeeping only
            later events            → handled as the stream would, NO call run
            each open custom call   → kept / OUTCOME_UNKNOWN / NOT_RUN
                                      (the last two: FAILED steps, one STEPS each)
        on open: the answers (or the opening, if it never reached the session)
        then the stream as today: dedup by id, kill + caps before each turn,
        every call through runGuardedTool, the session deleted at settle
```

### The call record

The Tool Runner's `WorkflowRunCheckpoint` row and its store, unchanged in
shape. Every turn's MODEL_CALL step writes the turn checkpoint in its own
transaction (`writeTurnCheckpointInTx` through `recordStep`'s `alsoInTx`); the
"transcript" is a sealed pointer, `{ format: 'inflect-managed-agents-session/1',
sessionId, spanEventId }`, because the conversation itself is at Anthropic.
The run's `SerialQueue` carries the same `CallCheckpointHooks`: the call is
named in flight (`markCallInFlight`) before it reaches the funnel, and its
result kept (`keepCallResults`, encrypted) once it settles, in the shape the
engine sends (`keptResultOf`, which the engine's own answer is now built by).

### The handover

A lost lease used to stop a Managed Agents run like an Abort: answer the open
calls "stopped", interrupt, delete the session. Under reconnection that is the
successor's session. So `checkKill` tells a lease ANOTHER worker holds
(`runLeaseTakenOver`) from one cleared to nobody: the first sets
`state.handedOver`, which skips the stop and the settle; the second (the
SIGTERM drain, the reaper) behaves as before. `settleSession` asks again before
it records anything and right before the delete, for a takeover the loop never
read.

### The reconciliation

`reconcileLostSessionDeletes`' abandoned-session pass reads the runs of its
aged candidates and drops every one that is RUNNING (`readRunningRunIds`).
The status decides, not the lease: a RUNNING run with no live lease is a dead
worker whose retry or takeover is on its way. That makes the race with a
reconnecting segment impossible rather than unlikely: a reconnect happens only
under a lease, a lease is held only on a RUNNING run, and a run that has left
RUNNING never re-enters the SAME segment (a person's resume is a new segment,
and a new segment's `runSegmentFromSeq` lies past every earlier session).

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/agent-driver.ts` | `SegmentRecovery` gains `SESSION`; Managed Agents takes it, Flue keeps `PAUSE_ON_RETRY` |
| `src/app-layer/types.ts` | `RequestContext.runSegmentFromSeq` |
| `src/app-layer/usecases/workflow-runs.ts` | anchors a `SESSION` segment, never pauses it, and hands the engine where it began |
| `src/lib/agentic/run-lease.ts` | `runLeaseTakenOver`: a lease another worker holds, not one cleared |
| `src/lib/agentic/managed-agents/reconnect.ts` | pure: the session checkpoint's format, seal and opening; the plan read off a history; the answer rule |
| `src/lib/agentic/managed-agents/store.ts` | `readSegmentLedger`: the segment's sessions, recorded spans and guard verdicts |
| `src/lib/agentic/managed-agents/execute.ts` | the reconnect, the checkpoint writes, the bounded history read, the handover |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | the abandoned pass skips a RUNNING run's session |
| `tests/helpers/managed-agents-faux.ts` | paged `events.list`, `beforeEventsPost`, `script` |

## Decisions

- **The checkpoint row, not a second store.** The brief asked for the existing
  one if it fits, and it does: its shape CHECK needs a transcript beside
  results and an in-flight id, and a sealed pointer is that transcript for an
  engine whose conversation lives elsewhere. The ledger alone could not do it:
  a TOOL_CALL step records the arguments, never the result (tenant content),
  and is written only when the call ends, so it can say neither what a kept
  result was nor which call was running. No migration.
- **A replayed turn's calls are answered, never run.** A call whose turn the
  ledger never recorded was provably never started (a call starts only after
  its turn's MODEL_CALL step and checkpoint commit), so running it would not be
  running it twice. The rule says every call with no result event is answered,
  and that is simpler to hold than an exception: such a call is
  `TOOL_CALL_NOT_RUN`, which tells the model it may make it again.
- **The segment's ledger is read before `settleUnrecordedSessions`.** That
  start records and deletes a session it finds unrecorded, at a seq inside the
  segment; read after it, the reconnect would take that settlement for the dead
  attempt's and refuse.
- **Interrupt in the history refuses.** Every stop the engine makes sends an
  interrupt; a session that holds one was being stopped when its worker died,
  and continuing it would complete a run that had been stopped. The run fails
  by name rather than settle as the dead attempt would have, because which stop
  it was (a cap, a guard verdict, an abort) is not known.
- **A verdict on any step of the session is latched again.** The dead attempt
  may have flagged a result and died before it acted; that result may be the
  one kept in the checkpoint. The reconnect stops first.
- **Drift refusals on reconnect delete the session** (the run ends there);
  their sentence says the run "was not continued" instead of "nothing was
  sent", which would be false.
- **The decision rows' digest** on a reconnected segment covers the opening
  message (re-derived: it is deterministic from the sealed run input) and what
  this segment sent. The results the dead attempt had sent are not
  reconstructable and are not in it; the row still says the prompt is held in
  the workspace (decision 3).
- **A drop mid-run reads the history through the same bounded reader.** It was
  an unbounded `for await` over every page; a session past the cap now stops
  the run by name. The stop's drain still reads the history unbounded: it ends
  at the first idle, and a stop must not be stopped by a cap.
- **No new session lifecycle value.** The reconnect is recorded on the first
  MODEL_CALL step (`reconnectedToSession`, `reconnectedAfterEventId`); a
  `SESSION_RECONNECTED` step would change the reconciliation's "only CREATED"
  rule for every reconnected session.
- **A new segment does not reconnect to an earlier segment's session.** Only a
  retry or a takeover of the SAME segment continues: that is the decision's
  scope, and it is what makes the reconciliation race impossible. An earlier
  segment's session left open (its worker died during a SIGTERM drain) is the
  reconciliation's once it is past the abandon age and its run is not RUNNING.
- **A lost lease cleared to nobody still stops and deletes**, as before: the
  SIGTERM drain pauses the run, and a person's resume is a new segment, which
  starts a new session.

## Not done

- **The window between `settleSession`'s last handover check and the
  delete.** A worker that wakes after a takeover and has already passed the
  check can still delete the successor's session. The successor then fails
  `managed_agents_reconnect_session_gone` or its next call fails; nothing is
  run twice.
- **A PAUSED run's open session** (its worker died mid-drain) waits for the
  reconciliation; a person's resume before then starts a new session beside it.
