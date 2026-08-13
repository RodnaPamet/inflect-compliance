# 2026-08-13 — A cadence edit stops forgiving the backlog; bulk delete gets a real gate

**Commit:** `<sha>` `fix(tests): anchor the cadence recompute; assert the admin gate on every bulk delete`

Two defects from the Tests-surface round, plus a third the second one's new ratchet
found on a different surface within a minute of being written.

## 1. Editing a plan's frequency silently cleared its overdue state

`updateTestPlan` recomputed the due date like this:

```ts
if (patch.frequency && patch.frequency !== existing.frequency) {
    const nextDueAt = computeNextDueAt(patch.frequency);   // ← no second argument
    await TestPlanRepository.updateNextDueAt(db, ctx, planId, nextDueAt);
}
```

`computeNextDueAt(frequency, fromDate: Date = new Date())` defaults its anchor to
**now**. So the new due date had nothing to do with the plan: a control three
months overdue became "due in a month" the instant anyone adjusted its cadence.
The compliance gap disappeared from `/tests/due`, the dashboard and every
notification, with nothing in the audit trail to explain where it went.

Nothing about a cadence edit says *"and forgive the backlog"*, which is why this
was invisible — the operator's intent was "test this quarterly now", and the
system quietly also granted absolution.

The fix anchors the recomputation to when the plan was **last actually tested**:

```
anchor = last COMPLETED run's executedAt
      ?? the previous nextDueAt
      ?? createdAt
```

A plan last tested four months ago that moves MONTHLY → QUARTERLY is still a month
overdue afterwards, because it is.

Two details worth keeping:

- **The anchor is queried, not read off the plan.** `getById` already includes
  `runs`, but only the latest 10 of *any* status — a plan with planned/running
  churn can push its last completed run out of that window. The new
  `TestPlanRepository.lastCompletedRunAt` asks the database directly.
- **A relaxed cadence may legitimately clear an overdue state.** A control tested
  four months ago genuinely is not overdue once it becomes an annual check. So
  that case is *recorded*, not blocked — a new
  `TEST_PLAN_OVERDUE_CLEARED_BY_CADENCE` audit entry naming the old and new
  cadence, the anchor, and both due dates. Preserving the overdue flag instead
  (the other option) would strand the plan permanently overdue with no way to
  clear it.

The sibling call at `test-plans.ts:276` already passed an anchor, and the create
path legitimately computes from now. Only the update path was wrong.

## 2. The admin gate on destructive bulk actions had no test

`assertCanBulkManageTestPlans` gates on `admin.manage` and is the only thing
stopping an EDITOR mass-deleting the test programme 100 plans at a time. It had
four references in `src/` and **zero** in `tests/`.

The audit that surfaced this proposed fixing
`tests/guards/bulk-actions-rollout.test.ts:89`, which declares the expected
permission as `/assertCanManageTestPlans\(ctx\)/` — the non-admin sibling —
"so the ratchet passes whether or not the admin gate exists".

**That prescription would have been wrong, and following it would have broken the
build.** The ratchet's `statusFn`/`assignFn` are `bulkSetTestPlanStatus` and
`bulkAssignTestPlan`, and those two use the EDITOR gate *by design*: pausing or
reassigning is recoverable, deleting the programme is not. Rewriting the regex to
the admin symbol would have asserted an admin gate on functions that intentionally
do not have one.

The real gap was narrower and worse: the destructive pair — `bulkDeleteTestPlan`
and `bulkRestoreTestPlan` — had no ratchet coverage **at all**, and the existing
`permission` check is matched against the *whole usecase file*, so a bulk delete
with no gate whatsoever still passed as long as some other function in the module
asserted something.

So the ratchet gained a new per-entity `deleteFn` + `deletePermission`, asserted
against the function's **own body** via `functionBodyOf`.

## 3. What that immediately found: EDITORs could mass-delete the vendor register

The new assertion went red on Vendor on its first run. `bulkDeleteVendor` used
`assertCanManageVendors` — `vendors.edit`, i.e. ADMIN **or EDITOR** — the same gate
as its own recoverable set-status and assign verbs. Every peer register gates the
bulk delete on admin: risk, control and asset via `assertCanAdmin`, policy via
`assertCanAdminPolicies`, test plans via `assertCanBulkManageTestPlans`.

So an EDITOR could soft-delete 100 vendors at a time while being refused the
identical action on every other surface. Now `assertCanAdmin`, matching its peers.

This is exactly the blind spot the whole-file regex created: the two recoverable
verbs in `vendor.ts` satisfied the old check on the delete's behalf.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/control/test-plans.ts` | anchored recompute + the overdue-cleared audit entry |
| `src/app-layer/repositories/TestPlanRepository.ts` | `lastCompletedRunAt` — the anchor, queried not sampled |
| `src/app-layer/usecases/vendor.ts` | `bulkDeleteVendor` gated on admin, matching every peer |
| `tests/guards/bulk-actions-rollout.test.ts` | per-entity bulk-delete admin gate, bounded to the function body |
| `tests/helpers/source-blocks.ts` | `functionBodyOf` promoted from a private copy in one guard |
| `tests/guardrails/task-status-machine-wiring.test.ts` | now imports the shared helper instead of duplicating it |
| `tests/unit/test-plan-cadence-and-bulk-gate.test.ts` | executes both defects |

## Decisions

- **Anchor, then record — not preserve the flag.** Both were offered. Preserving
  it makes a legitimately-retimed plan permanently overdue with no exit;
  recording keeps the history without freezing the state.
- **Query the last completed run rather than filter `getById`'s `runs`.** The
  included set is `take: 10` of any status, so filtering it is correct only until
  a plan accumulates eleven planned runs.
- **Kept the ratchet's existing `permission` regex.** It is correct for the two
  verbs it covers. The fix was to *add* the missing assertion, not to rewrite a
  right one into a wrong one.
- **Bounded the new assertion to the function body.** A whole-file match is what
  hid the vendor gap; repeating that shape would have hidden the next one.
- **`functionBodyOf` moved to `tests/helpers/source-blocks.ts`.** CLAUDE.md
  already directs bounded source reads at that module; the helper existed only as
  a private copy inside one guardrail, so the second caller would have duplicated
  it.
- **Fixed the vendor gate rather than allow-listing it.** It is a one-line
  inconsistency with five peers, found by a test written in the same diff; leaving
  it with a written excuse would have been the wrong trade.
