# 2026-11-13 — A person's resume of a reasoning run measures its clock from the resume (#5534)

## Design

`RUNTIME_MS` is the one run cap whose `used` is read from the clock, so the
instant the engine measures from decides whether a person's deliberation is
charged to the run. The inline static resume already passed `Date.now()`: the
deliberation is bounded by `approvalExpiresAt`, refused at the door, and
`RUNTIME_MS` bounds a stretch of unattended execution.

The reasoning engines (Flue, the Tool Runner) resume in the worker. The resume
wrote `stepCount` and enqueued `agent-run-execute` with the two ids, and
`executeQueuedWorkflowRun` measured from `row.startedAt` — so a guard-FLAGGED
run approved more than an hour after it started halted at `RUNTIME_MS` before
executing a step.

```
resumeWorkflowRun (person)                       worker
  isReasoningEngine ─► enqueue { tenantId,  ──►  executeQueuedWorkflowRun(t, r, { clockBase })
                                 runId,            queuedRunClockBase(clockBase, startedAt, now)
                                 clockBase: now }    ├─ valid  → clockBase   (the resume)
                                                     └─ absent / invalid → startedAt
  static ─► executeFrom(…, Date.now())
startWorkflowRun ─► enqueue { tenantId, runId }  (no base → startedAt, as before)
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/types.ts` | `AgentRunExecutePayload.clockBase?`; retry-policy comment says where the base comes from |
| `src/app-layer/jobs/executor-registry.ts` | forwards `clockBase` under `NamesEveryField`, so dropping it is a compile error |
| `src/app-layer/jobs/agent-run-execute.ts` | passes it to the usecase |
| `src/app-layer/usecases/workflow-runs.ts` | the resume puts `clockBase: Date.now()` in the job; `queuedRunClockBase` validates it in the worker; corrected the two comments that said the queued path was only a SIGTERM retry and that the resume measured from the run's start |

## Decisions

- **The base rides in the payload, not a fresh `Date.now()` in the worker.** A
  SIGTERM retry re-delivers the same payload, so it keeps the resume's base and
  a wedged segment cannot buy a fresh hour per attempt — the reason the old
  comment gave for not re-basing the queued path, which still holds for the
  retry and is now honoured by construction.
- **A start carries no base.** Its clock runs from `startedAt`, exactly as
  before; `startWorkflowRun`'s enqueue is unchanged.
- **Invalid bases fall back to `startedAt`, never forward.** Only server code
  enqueues this job, but the value crosses a queue: a non-finite value, one
  before the run started, or one more than five minutes ahead of the worker's
  clock is ignored with a WARN, and a base inside the skew is clamped to now.
  Every fallback is the stricter reading.
- **`approvalExpiresAt` is untouched.** It is still refused before the enqueue,
  so the re-base never extends a decision taken outside its window.
