# 2026-07-29 — Canvas privilege escalation + unbounded sub-flow recursion

**Commit:** `<sha>` fix(automation): close the canvas privilege escalation + cap subflow recursion

First of two PRs covering the automation security audit. This one carries the
CRITICAL and the recursion cap; the MEDIUM findings follow separately so the
escalation is not held up behind them.

## P1.1 — the escalation

`saveProcessMap` gates on `assertCanWrite` (EDITOR) and then called
`syncCanvasToRules`, which creates and updates `AutomationRule` rows. Rule
authoring through REST requires ADMIN (`assertCanManageAutomation` → `canAdmin`).
The canvas was a lower-privilege path to the same writes, with **zero**
`assertCan*` calls anywhere in the file.

The exploit path is concrete. `dataJson.ruleId` is typed `z.unknown()` in
`ProcessNodeInputSchema`, and `ruleIdOf` took it at face value, so
`ruleByNodeKey` would happily hold an id the caller does not own. The chain-edge
loop then calls `AutomationRuleRepository.update(...)` on it:

1. EDITOR saves a map with an action node carrying `dataJson.ruleId = <an
   ADMIN's rule id>`.
2. Same save adds a `chain-delay` edge from that node.
3. The loop rewires that rule's `nextRuleId` / `elseRuleId`.

### Fix — four parts

**Permission assert, conditional on writing.** A map with no action nodes and no
chain edges mutates no rule, and an EDITOR must keep editing plain document
canvases. Gating every canvas save on ADMIN would be a functional regression
unrelated to the vulnerability, so the assert fires only when the sync would
actually write.

**Claimed rule ids verified in-tenant.** `getById` runs tenant-bound, so a
foreign or deleted id resolves to null and is dropped rather than adopted. This
is load-bearing rather than belt-and-braces: the repository's `create` writes
`nextRuleId`/`elseRuleId` as **raw FK scalars**, and FK checks bypass row
security — an unvalidated id would persist as a cross-tenant reference.

**Cycle guard on the canvas path.** REST has run one since Epic 7. A canvas is
the easiest surface on which to draw a loop, and it was the one writer without
a guard.

**Audit naming the rule ids.** `saveProcessMap` already emits a
`ProcessMap/UPDATE` row — but it carries no rule ids, so a chain rewire left no
record of *which* automation rules changed.

### Two reviewer claims were false

Recorded because they shaped the fix by *not* being implemented:

- *"the save is entirely unaudited"* — false. `process-map.ts:113-131` emits an
  audit row; it simply names no rules. The fix adds rule-level detail rather
  than an audit trail that was missing.
- *"newly created canvas rules are immediately live"* — false.
  `canvas-rule-sync.ts` creates them `status: 'DRAFT'`, and
  `rule-chain-dispatch` only runs `ENABLED` rules. The escalation is rewiring
  existing enabled rules plus unbounded DRAFT creation, not instant execution.

## P1.10 (partial) — the dead cycle guard

`followChainHasCycle` was exported, unit-tested, and referenced by a guard that
greps its identifier — with **zero production call sites**.
`updateAutomationRule` re-implemented the identical walk inline.

The duplication was not laziness: the pure helper needs a **synchronous**
`nextOf`, and the real walk reads each hop from the database. The signature made
it unusable.

`assertNoChainCycle` resolves that — it collects the reachable sub-graph
asynchronously, then delegates the verdict to the pure function. The duplicate
is gone, the tested algorithm is live again, and it now covers `elseRuleId`,
which the old inline guard ignored despite `rule-chain-dispatch` following both
edges identically.

## P1.3(b) — sub-flow recursion

`rule-chain-dispatch` has enforced `MAX_CHAIN_DEPTH = 10` since Epic 7.
`subflow-dispatcher` had no cap at all, and `targetGroupId` is a free-form
string with no existence or self-reference check — so a group whose entry rule
invokes its own group recursed without bound.

Depth propagates through `__subflowDepth` on `event.data`, mirroring the
existing `__parentExecutionId` convention, and `invokeSubflow` increments it
when enqueuing the next hop. **The propagation is the fix** — a cap the caller
never increments is decorative.

Over the cap the job **refuses and returns** rather than throwing: a runaway
sub-flow is a misconfigured rule, not an infrastructure fault, and throwing
would put the job into retry, turning one bad rule into sustained queue
pressure.

## Files

| File | Role |
|---|---|
| `src/app-layer/services/canvas-rule-sync.ts` | Authz, id verification, cycle guard, audit. |
| `src/app-layer/usecases/automation-rules.ts` | New shared `assertNoChainCycle`; inline duplicate removed. |
| `src/app-layer/jobs/subflow-dispatcher.ts` | `MAX_SUBFLOW_DEPTH` + depth stamping. |
| `src/app-layer/jobs/types.ts` | `depth?` on `SubflowDispatchPayload`. |
| `src/app-layer/automation/action-executor.ts` | `invokeSubflow` increments depth. |
| `tests/unit/canvas-rule-sync.test.ts` | 12 tests; escalation, verification, cycle, audit. |

## Decisions

- **Every half is mutation-proved separately.** Dropping the permission assert
  fails 1 test; trusting claimed ids fails 1; removing the cycle guard fails 2.
  Three independent proofs rather than one suite that might pass for the wrong
  reason.

- **Restores during mutation testing come from a file copy, never `git
  checkout`.** Learned the hard way in this change: `git checkout` on an
  uncommitted file discarded the whole fix, and the next run's failures read as
  "thorough tests" rather than "no baseline". A mutation result means nothing
  unless the baseline is intact.

- **The conditional assert is the interesting call.** The safe-looking option —
  assert unconditionally at the top — would have been a silent functional
  regression for every EDITOR editing a non-automation canvas. Security fixes
  that quietly remove capability are still regressions.
