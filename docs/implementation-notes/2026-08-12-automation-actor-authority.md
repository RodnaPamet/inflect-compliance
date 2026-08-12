# 2026-08-12 — Automation rules execute under real tenant authority

**Commit:** `(pending)` fix(automation): resolve the rule principal's real role instead of fabricating ADMIN

## Design

`action-executor.ts` built its `RequestContext` by hand:

```ts
role: 'ADMIN',
permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
appPermissions: getPermissionsForRole('ADMIN'),
```

…while stamping a REAL person's `userId` on it. Two defects in one construction:

1. **Escalation.** `assertCanCreateTask` reads `permissions.canWrite` AND
   `appPermissions.tasks.create`. The fabrication cleared both unconditionally, so a
   custom role that withholds `tasks.create` — or a plain READER/AUDITOR — created
   tasks anyway, and the `TASK_CREATED` audit row named that user (`logEvent`
   hardcodes `actorType: 'USER'`).
2. **Wrong principal.** The identity was `event.actorUserId ?? rule.createdByUserId`
   — the member who happened to FIRE the trigger first. Authoring a rule requires
   `canAdmin` (`assertCanManageAutomation`), but firing one requires nothing, so any
   READER whose own action emitted the trigger wore ADMIN for the action's duration.

`resolveActorCtx(db, tenantId, userId)` replaces it. It reads the real
`TenantMembership` (`tenantId_userId` unique, `include: { customRole, tenant }`) and
mirrors `resolveTenantContext` exactly — `customRole?.baseRole ?? role`,
`parsePermissionsJson` when a custom role is present, and the shared
`computePermissions` so the coarse tier cannot drift from the granular one. Missing
or non-ACTIVE membership refuses outright. The principal is now the RULE AUTHOR,
with the firing actor as the author-less-rule fallback only — and that fallback is
resolved through the same real-membership path, so it grants nothing extra.

Refusal happens before the dedupe read, and surfaces as `{ ok: false, summary }`,
which the dispatchers already persist as `AutomationExecution.errorMessage` — an
operator sees *why* the automation was refused, not a silent no-op.

`tenantSlug` is now populated from the joined tenant. Without it
`emitTaskAssignedNotification` short-circuits on `!ctx.tenantSlug`, so the assignee
bell the surrounding comment promised had never actually fired.

## Files

| File | Role |
|---|---|
| `src/app-layer/automation/action-executor.ts` | `buildAutomationCtx` → `resolveActorCtx`; author-first principal; pre-flight `assertCanCreateTask` |
| `tests/integration/automation-actor-authority.test.ts` | DB-backed: real dispatcher + real `createTask`, four authority cases |
| `tests/unit/automation/action-executor.test.ts` | Real-role resolution, custom-role denial, non-ACTIVE refusal |
| `tests/unit/automation-action-executor.test.ts` | Membership stub; CREATE_TASK ownership flips to the author |

## Decisions

- **Author, not firing actor, is the principal.** Authorship is the `canAdmin`-gated
  act that declares intent; firing is not gated at all. The firing member stays on
  the execution row's `triggerPayloadJson` as provenance.
- **Fail closed, no SYSTEM escape hatch.** A platform-owned rule would need
  `actorType: 'SYSTEM'`, but `logEvent` hardcodes `'USER'` and takes no override
  (`src/app-layer/events/audit.ts:38`). Rather than widen that signature from the
  automation layer, an unresolvable principal simply refuses with a recorded reason.
- **Reuse the canonical predicate.** The executor calls `assertCanCreateTask` in a
  try/catch instead of re-testing the flags, so the HTTP path and the automation
  path can never disagree about what "may create a task" means.
- **Still out of scope, still open:** `UPDATE_STATUS` writes `db.{risk,task,control}.updateMany`
  directly — no usecase, no `checkReviewerSignOffGate`, no audit row. That is a
  separate four-eyes bypass and needs the usecase layer, not this context fix.
