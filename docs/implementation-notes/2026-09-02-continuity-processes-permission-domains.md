# 2026-09-02 — `continuity` + `processes` permission domains (#2197)

**Commit:** `<sha> feat(authz): add continuity and processes permission domains`

## Design

The `#2117` census had three `todo` entries left, and they shared one blocker
rather than three: `t/[tenantSlug]/business-continuity/[id]` (PUT + DELETE),
its `dependencies/[depId]` DELETE, and
`processes/[id]/snapshots/[version]/restore` (POST) all authorize through
`assertCanWrite`, which reads the role-tier `ctx.permissions.canWrite` bag.
`requirePermission` reads `ctx.appPermissions`, and `PermissionKey` is derived
from `PermissionSet` — which had no domain whose population matched. Binding
them to a neighbouring register's flag would have changed the caller set for a
reason unrelated to the route, so the third tranche left them in the census and
wrote down why.

This is option 1 from the issue: add the missing domains.

```
PermissionSet
  + continuity: { edit }      ← OWNER / ADMIN / EDITOR
  + processes:  { edit }      ← OWNER / ADMIN / EDITOR
        = computePermissions(role).canWrite  (role level >= 3)
        = the predicate assertCanWrite reads

PERMISSION_SCHEMA            + two keys
getPermissionsForRole        + two flags in all five branches
SCOPE_ACTION_MAP             + { write: ['edit'] } each   (api-key-auth.ts)
SCOPE_GROUPS                 + one operator label each    (admin api-keys page)
messages/{en,bg}.json        + resourceLabels.<domain>
ROUTE_PERMISSIONS            + six rules (fourth tranche)
```

Option 4 from the issue's comment — writing the row at the
`withApiErrorHandling` boundary — was rejected rather than deferred.
`ForbiddenError` is not an authorization signal: 225 `forbidden(` sites carry
business rules (`plan_limit_exceeded`, AV quarantine, last-OWNER), so the
boundary would poison the `AUTHZ_DENIED` population with refusals that are not
authorization decisions at all. And `resolveTenantContext` throws `forbidden`
before `mergeRequestContext`, so it structurally cannot reach the
highest-signal denials.

## Files

| File | Role |
| --- | --- |
| `src/lib/permissions.ts` | The two domains, their flags in all five role branches, and the docstring arguing why neither has a `view`. |
| `src/lib/auth/api-key-auth.ts` | `SCOPE_ACTION_MAP` — `continuity:write` / `processes:write`, no `:read` group. |
| `src/app/t/[tenantSlug]/(app)/admin/api-keys/page.tsx` | `SCOPE_GROUPS` — the operator-facing half of the same mirror. |
| `messages/en.json`, `messages/bg.json` | `admin.resourceLabels.*` for the custom-role grid. |
| `src/lib/security/route-permissions.ts` | Six declarative rules, fourth tranche. |
| `src/app/api/t/[tenantSlug]/business-continuity/**` | Five write handlers moved to `requirePermission('continuity.edit', …)`; both GETs untouched. |
| `src/app/api/t/[tenantSlug]/processes/**` | Collection POST, `[id]` PUT + PATCH, and the snapshot restore POST moved to `requirePermission('processes.edit', …)`. |
| `tests/guardrails/api-permission-coverage.test.ts` | Two roots; one exclusion for the read-only `dependency-options` route. |
| `tests/guardrails/destructive-route-denial-census.test.ts` | Three `todo` entries deleted, ratchet ceiling 3 → 0, two stale prose paragraphs corrected. |
| `tests/unit/security/destructive-route-denial-audit.test.ts` | Ten rows (EDITOR-allowed / READER-refused), floor 30 → 40. |
| `tests/unit/api-key-management.test.ts` | The `SCOPE_GROUPS` coverage assertion that did not exist. |
| `tests/unit/{sync-orchestrator,sync-conflict-deep,sync-concurrency-failure}.test.ts` | Three hand-written full-`PermissionSet` literals replaced by `getPermissionsForRole('OWNER')`. |

## Decisions

- **No `view` flag on either domain.** The issue asked whether `view` ships;
  the answer is no, and the reason is that nothing would read it. Reads on both
  registers gate on `assertCanRead`, which is `true` for all five roles, so a
  `continuity.view` checkbox in the custom-role editor would grant and revoke
  nothing — the exact drift #2225 fixed, one layer along. Making reads enforce a
  new flag is a real behaviour change (it would newly 403 every non-`*` API key
  that reads the register) and belongs to whoever needs to delegate read
  visibility. Both domains are therefore the first in `PermissionSet` with no
  `view`, deliberately.

- **The whole write surface, not just the three census routes.** The issue left
  `createBia` / `addBiaDependency` / `linkBiaToControl` on the coarse assert,
  which would have made the audit trail describe the detach of a BIA dependency
  and not the attach of the same edge. Every verb that reaches `assertCanWrite`
  on these two registers is gated on the matching key; every verb that reaches
  `assertCanRead` is not.

- **`deleteProcessMap` keeps `admin.manage`.** It asserts `assertCanAdmin`
  because ProcessMap is in neither `SOFT_DELETE_MODELS` nor the
  `SoftDeletableModel` union, so a mistaken delete has no restore path for any
  role. Using `processes.edit` there would hand every EDITOR an unrecoverable
  delete — the gate mirrors the assert in both directions, not just the lenient
  one.

- **Both domains got API-key scopes, and that was forced.** `appPermissions` for
  an API key comes from `scopesToPermissions(scopes)`, not from its role. So
  gating on a new domain means a key without a matching scope is refused — and
  without a scope to grant, `*` would have been the only key that could write a
  BIA. That is the #2225 defect exactly, so the two mirrors moved in the same
  diff. `<domain>:read` is deliberately not a valid scope: with no `view`
  action there is no flag it could set, and a scope resolving to nothing is
  worse than one that does not exist.

- **`SCOPE_GROUPS` had no coverage test, though the `PERMISSION_SCHEMA`
  docstring said it did.** Following that docstring is what found it. The new
  assertion reads the page source (the constant is not exported from a
  `'use client'` module), asserts the parse found something before comparing,
  and also checks every scope the UI offers is one `validateScopes` accepts —
  the mirror's other failure direction.

- **`withValidatedBody` → `parseJsonBody` on eight handlers, and it inverts
  their malformed-body response.** `withValidatedBody` passes the body as the third argument, which
  is the slot `requirePermission` uses for the resolved ctx. `parseJsonBody` has
  identical parse semantics and reads inline. The observable consequence: a
  malformed JSON body from an under-privileged caller answered **400** before
  and answers **403** now, because the gate runs before the parse. Refusing
  before parsing an unauthorized caller's payload is the better order, and 70
  route modules already paired the two before this diff — but it is an API-contract change and is
  called out as one.

- **No `ROUTE_PERMISSIONS` / `PRIVILEGED_ROOTS` entry for `processes/route.ts`
  or `processes/[id]/route.ts`.** Both still export an ungated GET on
  `assertCanRead`, and the coverage guardrail is satisfied by
  `requirePermission` appearing anywhere in a file — so registering them would
  assert coverage they have not earned. The gates write their audit rows either
  way; registration is a CI-visibility question. Same reasoning the DELETE in
  that file already carried, and the same shape as
  `calendar/connections/route.ts`.

- **Three sync-test fixtures stopped mirroring `PermissionSet` by hand.** They
  each carried an every-flag-true literal — byte-identical to
  `getPermissionsForRole('OWNER')` — which broke the build in three files at
  once every time the permission model gained a domain, for a fixture that only
  needs "an actor allowed to do everything". Deriving it removes three copies
  without changing a single resolved flag.

- **Census ratchet lowered to zero, not to a slack bound.** With no `todo`
  entries left, the three tests that iterate that subset are vacuous, so
  `toBeLessThanOrEqual(0)` is what keeps a new ungated destructive route from
  arriving quietly: it fails the exact-list assertion first, and adding a line
  to get green fails the ratchet. Both edits have to be argued.
