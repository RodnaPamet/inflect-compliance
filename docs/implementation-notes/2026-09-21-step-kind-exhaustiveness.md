# 2026-09-21 — A step kind is executed or refused, never silently skipped

**Commit:** `<sha>` fix(agentic): make the driver's step-kind chain exhaustive and fail closed

Phase 1, point 5: *"`costTokens` accumulates across **all** kinds, so a loop
cannot escape the cap by spending in a kind the counter ignores."*

## The escape is not a missing addition

It is the driver's `if / else if` chain having no final arm.

`costTokens` accumulates only INSIDE those branches. A step matching none of
them:

- records **no** `WorkflowStep` row — `recordStep` is called per branch;
- adds **nothing** to `costTokens`, so the delta charged below is zero;
- and still advances `stepCount` and commits the context.

So the failure is worse than a free step: a run could report itself **complete**
having silently skipped work, with a token charge of zero and no ledger entry
saying so.

The chain now ends in a `never` assignment followed by `failRun`. A fifth member
of `WorkflowStepDef` is a **build error** rather than a silent skip.

## The correction this note exists to record

The plan's wording points at `WorkflowStepKind`, and the obvious reading is that
the static driver needs `MODEL_CALL` and `TOOL_CALL` branches. **It does not,
and should not grow them.** There are two vocabularies and they are not the same
set:

| | |
|---|---|
| `WorkflowStepDef` | the shapes a workflow DEFINITION may declare — `READ`, `PROPOSE`, `HUMAN_CHECKPOINT`, `SYNTHESIS` |
| `WorkflowStepKind` | the kinds a driver may RECORD on a `WorkflowStep` — those four plus `MODEL_CALL`, `TOOL_CALL` |

`MODEL_CALL` and `TOOL_CALL` are the difference. They exist for a driver that
records what it *did*; they cannot appear in a hand-written step array, so the
static driver cannot meet one. A branch for them here would be dead code that
reads as support, and the next person would reasonably conclude a definition may
declare one.

Which means point 5's bullet is, for the static driver, **already satisfied** —
every kind a definition can declare does charge. The real exposure is a future
driver recording those kinds without charging, and that is the driver's own
obligation. Saying so plainly is better than adding branches that look like
coverage.

## What is enforced, and by what

**The compiler** protects the union: `const unhandled: never = step` cannot
compile once a fifth member exists. Proved by adding one — it produces
`Type 'ProbeStepDef' is not assignable to type 'never'` at that line, and
nothing else in the suite would have caught it.

**`tests/unit/workflow-step-kind-coverage.test.ts`** protects the relationship
the compiler cannot see:

- every kind the shipped workflows declare is one the database can record — the
  direction that fails at `recordStep` with a 22P02, mid-run, after the step has
  already executed;
- the kinds no definition can declare are **exactly** `MODEL_CALL` and
  `TOOL_CALL`, so a third one added to the enum forces someone to decide which
  vocabulary it belongs to;
- the static driver claims no capability for those two;
- and the population is asserted non-empty, because the first two assertions are
  satisfied by zero workflows.

The declared kinds are read off `listWorkflowDefinitions()` rather than
restated, so a workflow introducing a new shape shows up without anyone
remembering to update a list.

## Why `failRun` and not a throw

The unreachable arm still does something deliberate. A throw would surface as a
500 on a path where the run row already exists; `failRun` settles the run FAILED
with a message naming the kind, which is what an operator needs to see and what
every other halt in this driver does.
