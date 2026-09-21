# 2026-09-21 — A rolling deploy should not fail an agentic run

**Commit:** `<sha>` feat(agentic): leave in-flight runs resumable across SIGTERM

Point 10 of the Flue integration plan: *"A SIGTERM must leave the run resumable
from its last completed `seq`."* It was not, and the gap is in the engine we
already ship rather than in anything Flue-shaped — so it is worth closing now,
independently of whether that adoption proceeds.

## The failure

Runs execute inline: `executeFrom` walks the step array in the process that
served the request. A rolling deploy SIGTERMs that process mid-walk and the row
is left `RUNNING` with no executor.

Nothing notices for a long time. `agent-run-reaper` selects on
`updatedAt < now - WALL_CLOCK_MS - REAP_GRACE_MS`, so the run sits there for a
full wall-clock budget **plus ten minutes**, and is then settled to **FAILED**
with a permanent hash-chained row asserting it had no executor — true, and the
deploy's fault rather than the run's.

## What changed

A fourth shutdown stage moves **this process's** in-flight runs to `PAUSED`.

That is the whole change on the run side, because the resume machinery already
handles it. `resumeWorkflowRun` looks for a PENDING step, finds none (a SIGTERM
lands mid-step, not at a checkpoint), falls through its
`pending?.seq ?? run.stepCount - 1` branch and executes from `stepCount`.
`stepCount` is written as `seq + 1` at each step's commit, so that is exactly
the last completed seq plus one. **No new resume path was needed, and none was
added.**

| File | Role |
|---|---|
| `src/lib/agentic/in-flight-runs.ts` | the process-local registry and the drain |
| `src/app-layer/usecases/workflow-runs.ts` | a tracking wrapper around `executeFrom` |
| `src/lib/observability/shutdown.ts` | stage 2, guarded and budgeted |
| `src/lib/observability/shutdown-budget.ts` | `SHUTDOWN_PAUSE_RUNS_MS`, and a declared stage total |

## Decisions

### A process-local registry, because the database cannot tell whose run it is

The obvious implementation — "pause every RUNNING run" — is a cross-instance
outage. Pod A's SIGTERM would pause the runs pod B is actively executing, and B
would carry on writing to rows marked PAUSED. No query distinguishes them,
because the distinction is not in the database: it is which process holds the
run in memory.

So the set is in memory, written by the one function that executes runs. The
test that earns its place is the negative one — `leaves another process's run
alone` — because a drain that paused everything satisfies every other assertion
in the file.

### The tracking is inside `executeFrom`, not at its call sites

Two callers today (`startWorkflowRun`, `resumeWorkflowRun`). Putting the
track/untrack pair inside the function means a third cannot be added without it.
`finally`, not `then`: a run that threw is no longer executing, and leaving it
tracked would have the drain pause a row that has already settled to FAILED.

### Stage 2 of four — above OTel, below audit

Ranked by what the loss costs. Audit buffers are irreversible, so they stay
first. An abandoned run is worse than a lost span — it becomes a FAILED run an
hour later — so the pause goes above OTel. And it ranks below audit because
failing to pause degrades to *exactly today's behaviour*, which is recoverable
by an operator, while a dropped audit batch is gone.

Two seconds for one `updateMany` over a handful of ids, and the stage
short-circuits with no query at all when the process is executing nothing —
the common case.

### The write is conditional on `status: 'RUNNING'`

Between the snapshot and the write a run may complete, fail or be aborted. The
condition means the update cannot walk a settled run backwards into PAUSED,
which would put a finished run back in the resume queue. Same shape the reaper
uses.

### No audit row is written, deliberately

`appendAuditEntry` is hash-chained and therefore serialised, so N runs would
cost N dependent writes inside a budget measured in seconds — and stage 1 has
already flushed the audit stream, so anything written here would reach the
database but miss the SIEM. The run's own step ledger records where it stopped;
a structured log line records why.

## Two things the tests caught

**An unguarded `await` would have skipped OTel and Sentry.** The first draft
called `await pauseInFlightRuns(...)` bare, on the grounds that the function
promises never to throw. The audit stage above it does not extend that trust to
`flushAllAuditStreams`, and it is right not to: an unguarded rejection takes the
whole handler down and every stage after it. One bad database connection during
a deploy would have cost every span and every queued Sentry event as well. The
test `the later stages still run when the run pause throws` failed on exactly
that, and the call site now carries a `.catch` like its neighbour.

**The budget guard had stopped covering its own subject.**
`shutdown-budget-sanity` summed three named constants by hand. Adding a fourth
stage did not change that sum, so the ceiling check silently understated the
real budget by 2s — and would have kept passing however many stages were added.
It now reads a declared `SHUTDOWN_STAGES_TOTAL_MS`, with a second assertion that
the declared total really is the sum, because a total nobody checks is the same
defect one level up.

## What this does not do

It does not move run execution into the BullMQ worker, which is the other half
of point 10's first bullet. That is a larger change — `startWorkflowRun`
currently returns the run's final status synchronously, so moving it is an API
contract change — and it is the right shape only once something long-running
actually executes. This change makes the *existing* inline engine survive a
deploy, which is the part that is wrong today regardless of where execution
eventually lives.

Mutation-proved: pausing every RUNNING run instead of the tracked set turns the
cross-instance test red; dropping the `status: 'RUNNING'` condition turns two
red.
