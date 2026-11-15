# 2026-11-14 — A refused joiner plan creates nothing

**Commit:** `fix(identity): a refused joiner plan creates nothing at any rung`

## Design

`runIdentityJoinerPass` wrote the plan's row and then, at any rung above
DRY_RUN, handed the plan to `executePlannedCreates` without reading
`plan.refusal`. Three of the planner's refusals keep their per-starter
decisions, PLANNED ones included, because the identity verdicts are what the
rung exists to show: `BATCH_OVER_CAP`, `NO_DEPARTMENT_MAP` and
`NO_DEFAULT_GROUP`. So at AUTOMATIC a refused plan still created accounts in
the customer's directory. The per-run cap, which exists to stop a bad roster
morning from creating thirty accounts, was a sentence on the row and nothing
more.

The owner's decision (2026-11-14): when the plan carries a refusal, create
nothing. No provisioner or writer is constructed, no identifier is probed, no
journal row is written, and the row the plan already wrote records the refusal
by name as NOT_APPLICABLE, as every other refusal does.

The rule is held in two places:

- the call site skips the execute branch when `mode === 'DRY_RUN' ||
  plan.refusal !== null`;
- `executePlannedCreates` returns `NOTHING_EXECUTED` as its first line for a
  refused plan, before either factory is asked, so a second caller cannot
  execute one either.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-joiner-run.ts` | The gate at the call site and at the top of `executePlannedCreates`. |
| `tests/unit/jobs/joiner-refused-plan-creates-nothing.test.ts` | The three refusals produced by the REAL planner at AUTOMATIC, plus a positive control on the same fixture. |
| `tests/unit/jobs/joiner-execute-branch.test.ts` | A refusal kind the planner does not have, to hold the `refusal === null` form. |

## Decisions

- **Gated on `refusal === null`, never on a list of kinds.** A refusal the
  planner gains later is covered without anybody remembering this line.
- **No other path executes a plan.** The manual "Run now" route enqueues the
  same `identity-joiner-pass` job the 04:30 dispatch does, and that job calls
  `runIdentityJoinerPass`; there is no resume of a joiner pass. `createDirectoryAccount`
  has one caller, `executePlannedCreates`.
- **The execution-row update keeps its refusal arm.** `safeRecordExecution`
  still writes a refused plan's status as NOT_APPLICABLE and puts the
  execution block beside the refusal. A refused plan no longer reaches it, so
  the arm is a belt, kept so the row could never hide a create that happened.
