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
`src/lib/permissions.ts`. For a custom role it returns exactly what a request
gets. For a built-in role it keeps one coarse flag the jobs always carried,
below. `resolveInitiatorContext` adds the ACTIVE-membership lookup the two jobs
shared; the workflow run keeps its own lookup and calls `initiatorAuthority`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/context-system.ts` | `initiatorAuthority` and `resolveInitiatorContext` |
| `src/app-layer/jobs/evidence-import.ts` | context from `resolveInitiatorContext`; gate on `evidence.upload` |
| `src/app-layer/jobs/sharepoint-delta-sync.ts` | the same |
| `src/app-layer/usecases/workflow-runs.ts` | `rebuildRunContext` reads the custom role; exported for its test |

## Decisions

- **A built-in role keeps exactly the context it had.** The jobs projected
  their coarse flags from the granular set (`canWrite: evidence.upload`, or
  `risks.edit` for a run). For every built-in role that agrees with
  `computePermissions` in four flags of five. It differs in `canAudit`, which
  the jobs took from `audits.view` (true for every built-in role) and which a
  request gives EDITOR, READER and AI_ADMIN as false. Changing it changes what a
  built-in role's job carries, so it is the owner's call, and
  `initiatorAuthority` keeps the old value for a built-in role only. No reader
  of `canAudit` sits on the evidence import's or the delta sync's path.
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
