# 2026-10-26 — A job's context reads its initiator's custom role

**Commit:** `fix(jobs): build a job's context from its initiator's custom role`

## Design

Three pieces of background work act for the member who started them: the ZIP
evidence import (`initiatedByUserId`), the SharePoint delta sync
(`actorUserId`) and the worker that executes a queued workflow run
(`startedByUserId`). Each re-read that member's ACTIVE membership, which is
right: a revoked member stops the job. Each then built the authority from
`getPermissionsForRole(membership.role)`, which ignored the custom role a
request from the same member is built from. A role narrowed while the job sat
in the queue, or a path that enqueued without the route's check, therefore ran
with the built-in role's full set (#4362).

```
request:  resolveTenantContext        role           = customRole?.baseRole ?? role
                                      permissions    = computePermissions(role)
job:      initiatorAuthority          appPermissions = permissionsForMembership(m)
            ├─ resolveInitiatorContext   evidence-import, sharepoint-delta-sync
            └─ rebuildRunContext         workflow-runs
```

`initiatorAuthority` (`src/app-layer/context-system.ts`) is the request's rule,
read through `permissionsForMembership`, the shared form of it in
`src/lib/permissions.ts`. For every membership, custom role or built-in, it
returns exactly what a request gets. `resolveInitiatorContext` adds the
ACTIVE-membership lookup the two jobs shared; the workflow run keeps its own
lookup and calls `initiatorAuthority`.

The scheduled delta sync's actor is chosen by the same rule. The dispatcher
reads every active OWNER/ADMIN of the tenants it fans out to, oldest first,
resolves each through `initiatorAuthority`, and takes the first that passes
`mayRunDeltaSync` — the job's own gate. A connection with nobody qualifying is
not queued; it is logged and returned with `NO_ACTIVE_ADMIN` or
`NO_ADMIN_WITH_EVIDENCE_UPLOAD`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/context-system.ts` | `initiatorAuthority` and `resolveInitiatorContext` |
| `src/app-layer/jobs/evidence-import.ts` | context from `resolveInitiatorContext`; gate on `evidence.upload` |
| `src/app-layer/jobs/sharepoint-delta-sync.ts` | the same; `mayRunDeltaSync`, and the dispatcher's actor choice and `DELTA_SYNC_UNROUTABLE` reasons |
| `src/app-layer/jobs/executor-registry.ts` | the dispatch result reports unroutable connections |
| `src/app-layer/usecases/workflow-runs.ts` | `rebuildRunContext` reads the custom role; exported for its test |

## Decisions

- **A built-in role gets a request's coarse flags too** (owner decision,
  2026-10-26). The jobs projected their coarse flags from the granular set
  (`canWrite: evidence.upload`, or `risks.edit` for a run). For every built-in
  role that agrees with `computePermissions` in four flags of five; it differs
  in `canAudit`, which the jobs took from `audits.view` (true for every built-in
  role) and which a request gives EDITOR, READER and AI_ADMIN as false. Those
  three now carry false in a job, as in a request. Nothing on these jobs' paths
  moves with it: `assertCanAudit` is asked only by the audit-log list, the
  policy acknowledgement roster and the legacy snapshot verify, each reached
  from an HTTP route; `assertCanViewHistory` has no caller;
  `assertCanReadAutomationHistory` admits on `canRead`, which every role holds;
  and the MCP authorisation step reads only the read and write policies.
- **The dispatcher passes an ineligible admin over rather than queueing a sync
  the job would refuse.** Picking by built-in role alone would have left a
  tenant whose oldest ADMIN carries a custom role without `evidence.upload`
  with a scheduled sync that failed every four hours with the job's refusal.
  The query lost its `distinct: ['tenantId']`, because the first membership is
  no longer necessarily the actor; it stays uncapped, for the reason `distinct`
  replaced a cap.
- **The gate is the key, not the coarse tier.** Both jobs refused on
  `permissions.canWrite`, which equalled `evidence.upload` only because they
  derived it so. A custom role can hold the coarse tier without the key, or the
  key over a READER base, so the gate reads `appPermissions.evidence.upload`,
  the key both routes ask. For a built-in role the two are the same flag.
- **A soft-deleted custom role is applied, as a request applies it.**
  `resolveTenantContext` reads the link and never `isActive`, and
  `deleteCustomRole` clears every link in the same write, so a surviving link
  takes legacy data or a race. The job selects only `baseRole` and
  `permissionsJson`, so it cannot treat the row differently from a request.
- **The request path is not touched.** Extracting the rule out of
  `resolveTenantContext` would have made the two literally one function, but
  it changes every request's resolver in a background-job fix, and
  `tests/guardrails/enterprise-identity-epic.test.ts` pins that resolver's text.
  `tests/unit/initiator-context.test.ts` runs the real `resolveTenantContext`
  against `resolveInitiatorContext` for the same membership rows instead.
- **A new helper, not `resolveMemberContext`.** That one already resolves a
  custom role, but it unifies the coarse flags, derives its own request id and
  sets `tenantSlug`. Any of the three would change what these jobs carried.
