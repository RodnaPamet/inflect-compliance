# 2026-11-24 — A retried agent run continues its conversation (#5854 item 3)

**Commit:** `fix(agents): …` (see the branch `fix/fix-5854-continue-conversation`)

Owner decision of 2026-11-24, option 2 of
`2026-11-23-fix-5854-run-claim.md`: when an agent run on a reasoning engine
fails partway and is retried, or a lease takeover picks it up, it CONTINUES ITS
CONVERSATION. It does not start again from the opening message, and a tool call
the failed attempt already made is not made again.

## Design

### Tool Runner: continue from a checkpoint

```
reply asks for tools ──► recordStep(MODEL_CALL, alsoInTx: write checkpoint)
                          transcript = request.messages + reply   (sealed, encrypted)
                          results    = []                         (sealed, encrypted)
each call, in the run's ONE queue:
    start  ──► inFlightToolUseId = call       (fenced, BEFORE the funnel)
    funnel ──► TOOL_CALL step
    settle ──► results += its block, inFlight = NULL   (fenced)
turn ends  ──► results = the SDK's exact tool-result message (only if different)
compaction ──► transcript = compacted list less its last message, results = its last

retry / takeover ──► executeQueuedWorkflowRun ──► claim ──► engine
    DECIDED deferral?  resume from it (unchanged)
    else checkpoint?   openCheckpoint (seals, envelopes)
                       messages = transcript + one user message answering every call:
                           kept result                → as kept
                           named in flight            → TOOL_CALL_OUTCOME_UNKNOWN (error)
                           otherwise                  → TOOL_CALL_NOT_RUN (error)
                       tools   = stored definitions, runnables from the NEW offer
                                 (withdrawn → TOOL_WITHDRAWN_BEFORE_CONTINUATION)
                       clock   = min(worker base, now − checkpoint.elapsedMs)
                       lockedParams({ resume: { model, system, messages } })
```

The continuation reuses the deferral resume's path rather than a second one:
`lockedParams`' `resume` option, `resumedToolsFor` (now parameterised by its
refusal), the same seal-then-envelope opening. The first MODEL_CALL step of a
continued segment records `continuedFromSeq`.

### Flue and Managed Agents: pause a retry that already made a call

```
executeQueuedWorkflowRun(…, { segment })     segment = the job id's instant
    segmentRecoveryOf(driver) === 'PAUSE_ON_RETRY'?
        anchorSegment(segment, fromSeq)       first attempt: record it
                                              later attempt of the SAME segment: a retry
        retry AND a TOOL_CALL / MODEL_CALL step at ≥ the segment's start?
            pauseRetriedSegment: PENDING HUMAN_CHECKPOINT "retry-paused"
                                 + RUNNING → PAUSED, one transaction, audited
            (no engine runs)
```

### The checkpoint's life

| Run status after a segment | Checkpoint |
| --- | --- |
| RUNNING (an attempt threw; BullMQ retries) | kept |
| PAUSED (SIGTERM drain; a person resumes) | kept |
| AWAITING_APPROVAL (a deferral park, a guard hold) | cleared |
| anything else (COMPLETED, FAILED, ABORTED, EMPTY_CATALOGUE) | settled: cleared, `settledAt`, frozen |

Settled also by an operator's Abort (its transaction) and by the reaper.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/agentic.prisma` | `WorkflowRunCheckpoint` |
| `prisma/migrations/20261124120000_workflow_run_checkpoint/` | the table, its shape CHECK, the settled-frozen trigger, grants (no DELETE) and the RLS triple |
| `src/lib/security/encrypted-fields.ts` | `transcriptJson`, `resultsJson` in the manifest |
| `src/lib/agentic/drivers/checkpoint-store.ts` | the table's only writer: read, turn write, in-flight, results, clear, settle, the segment anchor, the retry pause |
| `src/lib/agentic/tool-runner/transcript.ts` | the checkpoint format, its seal and opening, the SDK's result block, the continued messages |
| `src/lib/agentic/tool-runner/tools.ts` | `SerialQueue` checkpoint hooks keyed by `tool_use` id; `resumedToolsFor`'s refusal parameter |
| `src/lib/agentic/tool-runner/execute.ts` | writes the checkpoint; opens and continues from it |
| `src/lib/agentic/tool-runner/skills.ts`, `delegate.ts` | pass the `tool_use` id to the queue |
| `src/lib/agentic/agent-driver.ts` | `segmentRecoveryOf`: `LEDGER` / `CHECKPOINT` / `PAUSE_ON_RETRY` per driver |
| `src/app-layer/usecases/workflow-runs.ts` | closes the checkpoint after every segment and refusal, settles it on Abort; the retry pause; `segment` on the start's and resume's enqueue |
| `src/app-layer/usecases/workflow-run-deferrals.ts` | `segment` on the decision's enqueue |
| `src/app-layer/jobs/types.ts`, `executor-registry.ts`, `agent-run-execute.ts` | `segment` in the payload, forwarded |
| `src/lib/agentic/drivers/deferral-store.ts` | the park clears the checkpoint in its transaction |
| `src/app-layer/jobs/agent-run-reaper.ts` | a reaped run's checkpoint settles |

## Decisions

- **A new table, not a column.** On `WorkflowRun`: `getRunRow` reads the row
  whole and every `updateRun` returns it whole (the audit extension's `after`
  snapshot), so a transcript there would be decrypted on every turn's accounting
  write, and a column write outside `updateRun` would be an unfenced write path
  to the run row. On `WorkflowRunDeferral`: a deferral IS a proposal the run waits
  on (`proposalId` unique, a one-way status a trigger holds), which a checkpoint
  is not. One row per run, `@@unique([tenantId, runId])`.
- **Checkpoint at the reply, not only at the end of the turn.** A checkpoint
  written only after the turn's tools would leave a death during the tools with
  the reply unrecorded, so the retry would ask the model again and could make the
  same call again. Writing the reply with its MODEL_CALL step means every call
  that runs has its reply in the checkpoint before it starts.
- **The in-flight marker is on the checkpoint, not in the ledger.** The brief's
  wording is "recorded in the ledger as started"; the ledger records a call only
  when it ends, and a `PENDING` step per call would double the ledger and its
  audit rows. The marker is one fenced write before the funnel. A call whose
  marker could not be written is not made.
- **Per-call results are built in the SDK's own shape** (`toolResultBlockOf`:
  `{ type, tool_use_id, content, is_error? }`, a throw as `Error: <message>`,
  which is the SDK's `thrownErrorText`), and the turn's exact SDK message
  replaces them when the turn ends, so a completed turn is always the SDK's
  bytes. Only a partial turn's completed calls use the built blocks.
- **The wall clock takes the stricter base.** `min(worker base, now − elapsed at
  the checkpoint)`: a crash retry keeps today's base (the run's start, or the
  resume's), and a person's resume of a paused run is charged the time the run
  had already spent unattended.
- **Only a leased execution keeps a checkpoint.** Only a run a worker executes
  under a lease is retried or taken over. This also leaves every inline run and
  every unit test of an engine, the conformance suite included, without a new
  query.
- **A guard hold clears rather than continues.** A run held at
  AWAITING_APPROVAL by the guard resumes from its opening message on a person's
  approval, as before: continuing it would put the flagged result in front of
  the model. A SIGTERM pause continues, because the drain is a death done
  gracefully.
- **Flue: not continued, and why.** Flue 2.3 continues a conversation only
  through its own durability: a `PersistenceAdapter`
  (`AgentSubmissionStore`, `ConversationStreamStore`, `AttachmentStore`) and its
  own coordinator, lease and retry budget, which replays the conversation stream
  and repairs an interrupted tool batch with unknown-outcome markers. It has no
  API to start an agent instance from a message list Inflect supplies; a new
  `dispatch` is a new submission. Inflect starts the runtime with no `db` (the
  in-memory default) on purpose. Adopting Flue's recovery would mean an Inflect
  adapter over encrypted tables and a second recovery coordinator beside the
  run lease. So Flue takes the fallback the brief allows: a retried segment that
  already made a call pauses.
- **Managed Agents: not continued, and why.** Its conversation lives in the
  session at Anthropic, and the design says a run never re-attaches to one
  (#5855 settles abandoned ones). Continuing would change that invariant, so it
  is an owner question; it takes the same pause.
- **The segment is named in the payload.** Telling a retry from a first attempt
  needs the segment's identity, which only the enqueue knows. The payload carries
  the same instant the job id names, compared for equality only. A job from an
  older build carries none and is never paused, as before.
- **The pause counts a MODEL_CALL too.** On Managed Agents a model call's step is
  recorded before the calls it asks for run, so a retry that finds one may have a
  call in flight that recorded nothing. On Flue the closing MODEL_CALL comes
  last, so it adds nothing there.

## Not done

- **Managed Agents re-attach** (owner question; see the report on the branch).
- **Flue's own durable store** (the gap above).
- A crash between an engine's settlement write and the checkpoint's settlement
  leaves the conversation in the row until the run is purged; the deferral
  transcript has the same window.
