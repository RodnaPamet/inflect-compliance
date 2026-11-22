# 2026-11-12 — An operator's Abort stops every engine, and stays the run's status

**Commit:** `fix(agentic): an operator's Abort stops the Tool Runner and Flue, and nothing settles over it (#5366)`

## Design

`abortWorkflowRun` writes ABORTED on the run row while an engine may still be
running. Three gaps let that stop be undone:

1. Only the static driver re-read the row between steps. The Tool Runner and
   Flue read the kill switch alone, so they went on calling the model and
   running tools after the abort.
2. Every engine settles through `updateRun`, which was an unconditional
   `update`: the engine's COMPLETED or FAILED replaced the operator's ABORTED.
3. `executeFrom` then stamped the decision rows written after the abort
   "no human review", for a run a person had reviewed and stopped.

The fix closes each at the layer that owns it:

```
abortWorkflowRun ──► row: ABORTED + OPERATOR_ABORT_MESSAGE, PENDING decisions → REJECTED
                         │
engine loop ──── isRunAborted (beside the kill read) ──► stop, settle nothing
                         │
updateRun ── status write? WHERE status <> 'ABORTED' ──► no-op (false), helper skips its audit row
                         │
executeFrom ── yieldToOperatorAbort ──► report ABORTED, REJECT decisions written after the abort
```

The engine check is the primary stop; the conditional write is the backstop
for an abort that lands between the engine's last check and its settlement;
`executeFrom` makes the report and the decision log agree with the row.

EMPTY_CATALOGUE is now treated as terminal everywhere it was missed: the abort
refuses it (by `isLiveRunStatus`, the shared allowlist of live statuses, rather
than a hand-written list of terminal ones), `settleRunDecisionLog` settles its
rows as a FAILED run's, and the settlement metric counts it as failed.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/drivers/run-settlement.ts` | `updateRun` conditional on a status write and returns whether it landed; `OPERATOR_ABORT_MESSAGE`, `readRunSettlementState`, `isRunAborted`; the settle helpers return ABORTED and write no audit row when the write did not land |
| `src/lib/agentic/tool-runner/execute.ts` | `checkKill` also reads the run status; an operator abort aborts the request and settles nothing; the EMPTY_CATALOGUE and COMPLETED writes report ABORTED when they did not land |
| `src/lib/agentic/tool-runner/tools.ts` | `OPERATOR_ABORT` stop kind, so a tool call after the abort is refused |
| `src/lib/agentic/flue/execute.ts` | `beforeModelCall` reads the run status after the kill; both settle paths return ABORTED first; the final write reports ABORTED when it did not land |
| `src/lib/agentic/drivers/static-driver.ts` | the context-integrity halt writes no audit row over an abort |
| `src/app-layer/usecases/workflow-runs.ts` | abort refuses non-live runs, writes conditionally and records the operator's reason; `yieldToOperatorAbort` in `executeFrom`; EMPTY_CATALOGUE in the decision-log and metric settlement |
| `tests/helpers/driver-conformance.ts` | `operator-abort-between-model-calls` scenario, held by every engine's adapter |

## Decisions

- **The operator's abort is identified by its reason, written by one writer.**
  `executeFrom` must tell an operator's ABORTED (decision rows REJECTED) from an
  engine's own (a kill or guard block: rows "no human review"), and by the time
  it runs the engine may have reported ABORTED for either. The row is the only
  place both are visible. `OPERATOR_ABORT_MESSAGE` is a code constant written
  only by `abortWorkflowRun`, and no engine can overwrite it because no settling
  write lands on an ABORTED row. As a fallback for a run aborted by a build that
  wrote no reason, a row that is ABORTED while the engine reported anything
  else is also the operator's.
- **The abort's reason replaces whatever reason the row carried.** A run parked
  by a guard FLAG and then aborted used to keep `flue_run_guard_flagged: …`,
  which no longer described why it stopped.
- **Accounting still lands on an aborted row.** A write without `status` (the
  running token and step counts) is not conditional: the calls before the abort
  were made and spent tokens, and the write touches neither the status, the
  reason nor `completedAt`.
- **A P2025 is checked against the row, not the error.** Only a row that reads
  ABORTED makes the write a no-op; a run that is not there still throws.
- **The status read is not swallowed in the engines.** A run whose status cannot
  be read is stopped by the engine's failure path rather than carried on as
  though nobody had pressed stop. `yieldToOperatorAbort` does swallow, because
  the row is already protected and a failed read must not turn a settled run
  into a thrown one.
- **The abort itself is conditional on a live status.** The mirror image of the
  engine fix: an engine that settled between the abort's read and its write
  keeps its settlement, and the caller hears `Run is already <status>`.
- **The Flue conformance adapter needs Node 24** (the `flue` Jest project), so
  the Flue half of the new scenario runs in CI; a unit test in
  `flue-kill-switch-stops-the-model-call.test.ts` holds the same behaviour in
  the node project.
