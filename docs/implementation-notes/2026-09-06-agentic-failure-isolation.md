# 2026-09-06 — agentic failure isolation (OWASP ASI08)

**Commit:** branch `feat/agentic-9d` — `feat(agentic): bound cascading failure at the step, agent and enumeration seams` (the sha is deliberately not quoted: this note is committed WITH the change, so any sha written here names a commit that no longer exists the moment the commit is amended or squashed)

## Design

Three places on the agentic path could turn one fault into a cascade. They are
different shapes and only two of them were broken.

```
  a run's steps          ── executeFrom()            one throw ⇒ whole run FAILED, unresumable
  a fan-out's members    ── (no site existed)        nothing fanned out over agents at all
  the enumeration        ── (no site existed)        the reaper is the first one, and it drains
```

**Step level.** `executeFrom` marked the run `FAILED` on any thrown step. That
is a terminal state `resumeWorkflowRun` refuses, so every step that had already
succeeded — its outputs, its sealed context, its ledger — was stranded. A step
may now declare `continueOnFailure`, in which case the failure is recorded
against the STEP and the run carries on. The default is `false` and reproduces
the old behaviour exactly.

**Agent level.** `isolateEach` in `src/lib/agentic/failure-isolation.ts` runs a
list of members, isolating the failures that may be isolated and halting on the
ones that may not. It returns counts, not just survivors.

**Enumeration level.** `agent-run-reaper` settles workflow runs left `RUNNING`
by an executor that died. It enumerates with `drainPages`, groups by
`(tenant, agent)`, and nests two `isolateEach` fan-outs — agents outside, that
agent's runs inside.

### Isolation must not become swallowing

A `try/catch` that continues quietly is a silent truncation wearing a different
hat: the batch reports success and nobody learns a member failed. So every
caught failure is recorded in three places and the batch's own result carries
the count:

| where | what it says |
| --- | --- |
| `StartWorkflowResult.stepFailures` | how many steps this run isolated |
| `WorkflowStep` row (`status: 'FAILED'`) | which step, and why, durably |
| `AuditLog` `WORKFLOW_STEP_ISOLATED_FAILURE` | hash-chained, digest only |
| `agentic.fanout.member_failed` | rate, labelled by failure kind |
| `AgentRunReaperOutcome` / `JobRunResult.details` | `agentsFailed`, `runsFailed` |

A caller cannot read the run's status without `stepFailures` sitting beside it.

### Where isolation is WRONG, and how the code tells

Some faults invalidate the batch rather than one member of it: a
context-integrity halt, an operator kill, a budget breach. Continuing past one
of those is the cascade arriving through the door built to stop it.

The two are told apart by a **brand**, never a message match. `isAgenticFatal`
is true for a `ContextIntegrityError`, for an `AgenticFatalError`, and for
anything else carrying `agenticFatal === true`. The property read (rather than
an `instanceof` chain) is what lets a sibling module — a kill switch, a cap —
mark its own error fatal without this module importing it.

Consequences, all asserted:

- a fatal ends the run **even on a step that declared `continueOnFailure`**;
- a fatal **halts** a fan-out — and the halt is announced, not trimmed:
  `outcome.halted` names it and `outcome.unattempted` counts the members nobody
  reached;
- `HUMAN_CHECKPOINT` cannot opt in at all (`continueOnFailure?: never`), because
  a checkpoint's only job is to park the run for a human, so a throw there means
  the run could not be parked.

Unbranded is isolable, and that default is the safe one: an unrecognised fault
on one member must not be able to take out the others by being unrecognised.

### A halt is not a truncation, and neither is a page

Two disciplines from the same principle. The reaper enumerates with
`drainPages`, not `take: N`: at a cap, "500 wedged runs" and "at least 500,
the rest untouched" are the same log line, and the tail is other tenants'
agents. And when a fatal stops a fan-out, the outcome reports how many members
went unattempted rather than reporting the prefix as a finished pass.

### Failure detail is a digest

`local/no-raw-prompt-logging` is active here, and an error message on this path
can quote a tool argument or a model's own words (a Zod issue quotes the value
it rejected). `describeFailure` returns the error's class or declared code plus
a truncated SHA-256 of the message, and no caller is offered the message. The
digest still correlates repeats, which is what an operator watching a spike
needs. The message keeps going to `WorkflowStep.outputJson`, which is encrypted.

## Files

| file | role |
| --- | --- |
| `src/lib/agentic/failure-isolation.ts` | new — `isolateEach`, `isAgenticFatal`, `AgenticFatalError`, `describeFailure` |
| `src/lib/agentic/workflow-types.ts` | `continueOnFailure` on READ/PROPOSE/SYNTHESIS; `?: never` on the checkpoint |
| `src/app-layer/usecases/workflow-runs.ts` | the step catch decides isolate-vs-end; `stepFailures` on every exit and on the public result |
| `src/app-layer/jobs/agent-run-reaper.ts` | new — `drainPages` enumeration + two nested isolated fan-outs |
| `src/app-layer/jobs/types.ts` | `AgentRunReaperPayload`, map entry, `JOB_DEFAULTS` entry |
| `src/app-layer/jobs/executor-registry.ts` | executor registration |
| `src/app-layer/jobs/schedules.ts` | hourly at `:37` |
| `src/lib/observability/metrics.ts` | `agentic.fanout.member_failed`, `agentic.fanout.halted` |
| `tests/guards/no-raw-prompt-logging.test.ts` | re-measured census: sinks 45 → 51, holes 97 → 99 |

## Decisions

- **`continueOnFailure` defaults to false.** Making every step optional would be
  the same defect pointing the other way — a run that quietly reasons over less
  than its definition asked for. The opt-in is per step and is written in the
  workflow definition, where somebody reviews it.

- **The isolated step still commits the context forward.** The failed step wrote
  nothing into the context, but `stepCount` advances, so the run's progress is
  durable rather than stranded. That is the half that makes the abort
  recoverable.

- **A fan-out over agents did not exist, so the reaper is where one was built.**
  The survey found exactly one already-isolated fan-out on this path (the MCP
  JSON-RPC batch loop in `src/app/api/mcp/route.ts`, which turns each member's
  throw into that member's JSON-RPC error) and no per-agent fan-out at all. The
  reaper is a real gap — nothing settles a `RUNNING` row whose executor died, so
  the agent reads as busy forever and its per-run budget is never released —
  and it is the natural first caller of the primitive.

- **`AWAITING_APPROVAL` and `PAUSED` are never reaped**, however old. Those runs
  are waiting for a person; reaping one destroys work somebody was about to
  approve. Only `RUNNING` past `WALL_CLOCK_MS + REAP_GRACE_MS` qualifies, and
  that window is safe precisely because the engine checks the same cap before
  every step: a genuinely live run would have failed itself.

- **The reap is a conditional `updateMany` on `status: 'RUNNING'`.** A run that
  came back to life between the enumeration and the write is left alone, and
  `count === 0` is reported as "not reaped" rather than as a failure — a row the
  sweep chose not to touch is not a row the sweep failed on. It also makes the
  job idempotent, which is why it carries two retry attempts rather than three.

- **An inner fatal is rethrown, not absorbed.** `FatalGroupError` re-exposes the
  brand and the original code so the outer fan-out classifies it as fatal too.
  Absorbing it into that agent's result would have let a kill stop one agent and
  leave the sweep running, which is the opposite of what a kill means.

- **`pageSize` is an option on the job.** It bounds memory per round-trip, never
  the result set, and being overridable is what lets a test force the walk across
  a page boundary with five rows — the exact behaviour a `take:` cap gets wrong.

- **Log field names are literals in the new job.** `component: COMPONENT` is an
  identifier `local/no-raw-prompt-logging` cannot resolve, so it counts as a hole
  in that rule's census; spelling the string out costs nothing and keeps the new
  file contributing zero opacity. The audit row passes `run.startedAt` rather
  than an inline age subtraction for the same reason.
