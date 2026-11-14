# Automation events & rule dispatch (Epic 60)

This is the contributor guide for the backend that makes "when X
happens, do Y" rules possible. Epic 60 shipped the plumbing — tables,
bus, dispatcher, execution history; later epics added the rule-builder
UI (`RuleBuilderModal` / `RulesTab` / `RuleDetailSheet`) and the live
action handlers (`action-executor.ts`). **Always build on these
primitives; never hand-roll a replacement.**

## What Epic 60 provides

```
src/app-layer/automation/
├── events.ts                         catalogue of trigger event names
├── event-contracts.ts                typed discriminated-union events
├── types.ts                          config/filter/DTO types
├── policies.ts                       RBAC (read/manage/execute/history)
├── filters.ts                        matchesFilter() for triggerFilterJson
├── automation-bus.ts                 emit / subscribe / dispatcher seam
├── action-executor.ts                executeAction — live action handlers
├── bus-bootstrap.ts                  wires bus → BullMQ at startup
├── AutomationRuleRepository.ts       tenant-scoped CRUD
├── AutomationExecutionRepository.ts  append-only history
└── index.ts                          barrel — import from here

src/app-layer/jobs/
├── automation-event-dispatch.ts      per-event dispatch executor
└── types.ts                          AutomationEventDispatchPayload
```

**Persistence.** Two tables (`AutomationRule`, `AutomationExecution`)
plus three Postgres enums. Migration:
`prisma/migrations/20260422170000_automation_foundation/`.

**Event contracts.** A discriminated union — one variant per known
event with its own `data` payload. Producers get compile-time shape
enforcement; the `_catalogueCheck` assertion in `event-contracts.ts`
fires a TypeScript error if a catalogue entry lands without a
contract variant.

**The bus.** Module-level singleton. `emit()` stamps tenantId from
`RequestContext` (non-forgeable), fans to in-process subscribers,
hands off to a pluggable dispatcher. Default dispatcher: no-op.
Production dispatcher: BullMQ-backed, enqueues an
`automation-event-dispatch` job per event.

**The dispatcher.** One job per event. Loads `ENABLED`, non-deleted
rules matching `(tenantId, triggerEvent)` in priority order, runs
`matchesFilter` against `triggerFilterJson`, insert-to-claims a
`PENDING` `AutomationExecution` row, advances to `RUNNING` →
`SUCCEEDED`/`FAILED`. Idempotency via unique
`(tenantId, idempotencyKey)` — P2002 is silent-skip.

**Action execution is live.** The dispatcher invokes
`executeAction` (`src/app-layer/automation/action-executor.ts`) per
matched rule, which fires the real side effect for the rule's
`actionType` (`NOTIFY_USER`, `CREATE_TASK`, `UPDATE_STATUS`,
`WEBHOOK`, `INVOKE_SUBFLOW`), records the outcome in `outcomeJson`,
and marks the execution `SUCCEEDED`/`FAILED` accordingly — see
"Extending the dispatcher" below.

**Sub-flow groups are canvas nesting.** `INVOKE_SUBFLOW` names a group node
by its `nodeKey` (`targetGroupId`, chosen in the rule builder from the
tenant's groups on live automation canvases). The subflow dispatcher starts
the group's ENABLED rule with the highest `priority` (ties: oldest, then id)
as a child execution whose `parentExecutionId` is the invoking execution. A
rule is in a group when its canvas step sits inside that group node — its
nearest enclosing group only — and the canvas save is the only writer of
`AutomationRule.subFlowGroupId` (`services/canvas-subflow-membership.ts`): it
sets the key, and clears it when the step leaves the group or is removed, or
the group is removed.

---

## Adding a new automation event

Four small changes, in this order:

### 1. Catalogue entry — `src/app-layer/automation/events.ts`

```ts
export const AUTOMATION_EVENTS = {
  // ...
  VENDOR_RENEWAL_DUE: 'VENDOR_RENEWAL_DUE',
} as const;
```

### 2. Contract variant — `src/app-layer/automation/event-contracts.ts`

```ts
export interface VendorRenewalDueData {
    vendorName: string;
    dueInDays: number;
    contractValue: number | null;
}

export type AutomationDomainEvent =
    | ...existing members...
    | (AutomationEventMetadata & { event: 'VENDOR_RENEWAL_DUE'; data: VendorRenewalDueData });
```

If you forget this step, the compile-time `_catalogueCheck` fails.

### 3. Emit from the usecase

Two patterns, pick whichever matches the area:

**Pattern A — extend an audit emitter helper.** Most domains
(risk/test/onboarding) already have a thin emitter file in
`src/app-layer/events/*.ts`. Add the `emitAutomationEvent` call
next to the existing `logEvent`:

```ts
import { emitAutomationEvent } from '../automation';

export async function emitVendorRenewalDue(
    db: PrismaTx, ctx: RequestContext,
    vendor: { id: string; name: string; dueInDays: number; contractValue: number | null }
) {
    await logEvent(db, ctx, { action: 'VENDOR_RENEWAL_DUE', ... });
    await emitAutomationEvent(ctx, {
        event: 'VENDOR_RENEWAL_DUE',
        entityType: 'Vendor',
        entityId: vendor.id,
        actorUserId: ctx.userId,
        stableKey: `${vendor.id}:${vendor.dueInDays}`, // dedupe handle
        data: {
            vendorName: vendor.name,
            dueInDays: vendor.dueInDays,
            contractValue: vendor.contractValue,
        },
    });
}
```

**Pattern B — inline at the mutation site.** Where the usecase
already calls `logEvent` directly (task.ts, issue.ts), add the
`emitAutomationEvent` call in the same block. Read any pre-mutation
state you need (e.g. `fromStatus`) once and pass it to both writers.

**`stableKey` is optional but strongly recommended.** Set it when
the producer can retry the same logical event (e.g. a scheduled
sweep that re-fires on process restart). The dispatcher derives the
execution idempotency key from `(ruleId, event, stableKey)`, so a
duplicate emission never double-fires an action.

### 4. Test the wiring

Mirror one of the existing emitter tests — the shape is:
`resetAutomationBus()` → subscribe on the bus → call your emitter
→ assert the subscriber received the event with the expected
`data` + `stableKey`. See
`tests/unit/automation.task-issue-wiring.test.ts` for a template.

---

## Calling the bus directly (non-usecase paths)

Anywhere you have a `RequestContext`, import and call:

```ts
import { emitAutomationEvent } from '@/app-layer/automation';

await emitAutomationEvent(ctx, {
    event: 'RISK_STATUS_CHANGED',
    entityType: 'Risk',
    entityId: risk.id,
    actorUserId: ctx.userId,
    data: { fromStatus: 'OPEN', toStatus: 'MITIGATING' },
});
```

- `tenantId` and `emittedAt` are stamped by the bus. You can't
  supply them, which eliminates a whole class of cross-tenant bug
  at the type level.
- `actorUserId: null` is reserved for system-originated events; for
  user-triggered mutations always pass `ctx.userId`.
- The call is fire-and-forget from the caller's perspective —
  handler errors never propagate out of `emit()`.

---

## Extending the dispatcher

The action step in
`src/app-layer/jobs/automation-event-dispatch.ts` calls
`executeAction` (`src/app-layer/automation/action-executor.ts`),
which switches on `rule.actionType` and invokes the matching handler
with the event + action config:

```ts
// Look up the handler by rule.actionType, invoke it with the event
// + action config, and record the outcome on the execution row.
const outcome = await executeAction(prisma, rule, {
    event, actionConfig: rule.actionConfigJson, executionId,
});
```

To add a new action type, add a `case` to the `switch` in
`executeAction` and a handler function alongside the existing
`notifyUser` / `createTask` / `updateStatus` / `fireWebhook` /
`invokeSubflow`.

**Non-negotiable invariants when you add a handler:**
- Keep insert-to-claim + P2002 silent-skip. Actions must not run
  before the row is claimed.
- Keep the `status = PENDING` gate on the `RUNNING` transition.
- Write `SUCCEEDED` or `FAILED` exactly once per execution.
- Every side-effect must carry its own idempotency (e.g. the
  `CREATE_TASK` handler should use `stableKey`-derived dedupe on
  the Task it creates).
- Actions are **tenant-scoped**. Read
  `event.tenantId`, never infer from config.

---

## Filter evolution (DSL v2)

`matchesFilter` evaluates the **DSL v2** filter shape (Epic 4):
`triggerFilterJson` is either a recursive `FilterGroup`
(`{ logic, conditions[] }` with AND/OR grouping and the
`eq/neq/in/not_in/gt/lt/contains` operators) or a legacy flat
equality map. The two shapes coexist — pre-Epic-4 rows keep firing
without a migration. A `null`/`undefined` filter matches every event
of its type; conditions read only `event.data`; unknown fields fail
closed. To extend the operator set, edit `evalCondition` in
`filters.ts` — keep both shapes supported so legacy rows do not break.

---

## Testing map

| Test | Covers |
|---|---|
| `automation-schema.test.ts` | Prisma enums ↔ Postgres enums, unique constraints, FK RESTRICT, defaults |
| `automation-event-bus.test.ts` | Bus emit/subscribe/wildcard/unsubscribe, tenant stamping, dispatcher seam |
| `automation.bus-bootstrap.test.ts` | Bus → BullMQ serialization + install idempotency |
| `automation-event-dispatch.test.ts` | Dispatch executor: rule lookup, filter eval, P2002 silent dedupe, action-throw → FAILED |
| `automation.event-contracts.test.ts` | Discriminated-union narrowing, catalogue ↔ contract parity |
| `automation.events.test.ts` | Catalogue integrity (no dupes, no empties) |
| `automation.filters.test.ts` | `matchesFilter` equality + unknown-key-fails-closed |
| `automation.policies.test.ts` | RBAC matrix across ADMIN/EDITOR/READER/AUDITOR |
| `automation.repositories.test.ts` | Tenant scoping on every repo call |
| `automation.emitter-wiring.test.ts` | Risk/test/onboarding audit emitters fan out to bus |
| `automation.task-issue-wiring.test.ts` | Task/Issue usecases publish events |
| `integration/automation-event-flow.test.ts` | End-to-end: emit → dispatch → execution row, real DB |

When adding new events, expand the wiring test + the catalogue
test. The contracts + schema tests catch drift automatically — if
either fails, something structural moved.

---

## Don'ts

- **Don't** bypass the bus and write `AutomationExecution` rows
  directly from a usecase. The dispatcher is the single writer.
- **Don't** add a new action type without also adding a Prisma
  migration to extend the `AutomationActionType` enum.
- **Don't** put action-specific config in a scalar column — shape
  goes in `actionConfigJson`; only the class is enum-gated.
- **Don't** broaden `matchesFilter` in place. Version it if you
  need more power.
- **Don't** re-export `AutomationDomainEvent` from a new barrel.
  Everything is at `@/app-layer/automation` — one import surface.
