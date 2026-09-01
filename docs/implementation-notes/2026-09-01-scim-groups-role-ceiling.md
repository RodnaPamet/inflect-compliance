# 2026-09-01 — SCIM Groups role ceiling + protected memberships

**Issue:** #2200 (and the invariant documented at `scim-users.ts` since the
original SCIM work).

## Design

The invariant "SCIM NEVER creates or promotes to ADMIN" was enforced on the
**Users** path only. `SCIM_ROLE_MAP` lived inside `scim-users.ts` and was read
by `resolveScimRole` and nothing else, so the **Groups** path — which resolves a
role by matching a pushed `ScimGroup.externalId` against the tenant's
`TenantEntraGroupMapping` rows, where `ENTRA_MAPPABLE_ROLES` legitimately
includes ADMIN — could reach `tenantMembership.update({ data: { role: 'ADMIN' } })`.
`/api/scim` is a middleware public path, so neither the tenant gate nor either
rate-limit tier runs in front of it.

Five changes:

1. **One ceiling, two readers.** `src/lib/scim/roles.ts` holds
   `SCIM_ASSIGNABLE_ROLES` (`READER | EDITOR | AUDITOR`). `scim-users.ts`
   *derives* `SCIM_ROLE_MAP` from it; `scim-groups.ts` passes it to
   `syncEntraMembershipRole`.

2. **The clamp is at resolution, not at the call site.**
   `resolveRoleFromGroups` gained `options.assignableRoles`, which filters the
   matched mappings **before** the winner is sorted out of them. A call-site
   check (`winner.role === 'ADMIN' → refuse`) would be a different, worse thing:
   a user in both an ADMIN-mapped and an EDITOR-mapped group would end up with
   *no* role rather than EDITOR. `matchedGroupIds` still reports the full
   matched set, because the group gate and the audit row mean "groups this user
   is in", which a ceiling does not change; the dropped ones surface separately
   as `clampedGroupIds` (logged, not silent).

3. **A ceiling-bound caller may not touch a protected membership.**
   `syncEntraMembershipRole` returns `role_protected` (a new metric outcome)
   when `assignableRoles` is supplied and the existing membership role is not in
   it. This is the Groups-path mirror of the `membership.role !== 'ADMIN'` guard
   that the Users path already carried: without it, SCIM could not promote an
   ADMIN but could still demote one.

4. **The status writes are guarded.** `scimPatchUser`, `scimPutUser` and
   `scimDeleteUser` each wrote membership status with no role guard, three lines
   from a role write that had one — so SCIM could not change an ADMIN's role but
   could switch that ADMIN off. `scimCreateUser`'s reactivation branch was a
   fourth such write. All four now consult `isScimProtectedRole`.

5. **`externalId` is validated, and `membersJson` is no longer echoed.**

## Files

| File | Role |
| --- | --- |
| `src/lib/scim/roles.ts` | NEW — the ceiling, plus `isScimProtectedRole` (its complement) |
| `src/lib/scim/auth.ts` | NEW `ScimForbiddenError` — a 403 subclass of `ScimAuthError`, so every route's existing catch renders it |
| `src/lib/scim/types.ts` | `isScimGroupExternalId` — UUID, matching the `aadGroupId` constraint |
| `src/lib/auth/entra-role-mapping.ts` | `assignableRoles` option; `clampedGroupIds` in the result |
| `src/lib/auth/entra-group-sync.ts` | Threads the ceiling; `role_protected` early return; WARN on a clamp |
| `src/lib/observability/metrics.ts` | `role_protected` outcome |
| `src/app-layer/usecases/scim-groups.ts` | Passes the ceiling; `normalizeMembers` at ingest; resource projected from `memberIds` |
| `src/app-layer/usecases/scim-users.ts` | `SCIM_ROLE_MAP` derived; `assertScimMayWrite` on all four status writes |
| `src/app/api/scim/v2/Groups/route.ts` | Requires a UUID `externalId`; no `?? displayName` |

## Decisions

- **Refusals throw a 403 rather than skipping silently, unlike the role writes.**
  A `DELETE` that answers `204` having written nothing tells the IdP the user was
  deprovisioned when they were not. The exception is `POST /Users`, whose
  contract is idempotent-create: there the reactivation is skipped and the
  response reports the membership's *real* status (it previously hard-coded
  `'ACTIVE'`, which was a lie for an `INVITED` membership too).

- **A no-op status push is not refused.** A full IdP sync re-pushes
  `active: true` for every user every cycle; 403-ing that on an already-ACTIVE
  ADMIN would break routine provisioning while protecting nothing. Only a real
  transition is refused.

- **`isScimProtectedRole` is defined as the complement of the ceiling**, not as
  a second list. A role added to `Role` is protected by default; a role added to
  the ceiling becomes writable in exactly one place. It reads the *enum* role
  only — a membership with an assignable base role and a permissive
  `customRoleId` is still SCIM-writable. That is a separate decision, noted in
  the source.

- **Members are projected from `memberIds`, not `membersJson`.** `membersJson`
  is raw pushed input, and `scimPatchGroup` does not update it, so it is stale
  after any PATCH. Inbound member values are still matched against
  `UserIdentityLink.externalSubject` only — resolving IC User ids on the way IN
  would let a token holder add any user in the tenant to a role-mapped group
  with no identity link, which is the same escalation by another door.

- **`resolveRoleFromGroups` returning `null` is still a NO-OP, and that is out of
  scope here.** Removing an ADMIN mapping does not demote anyone; the documented
  remedy is `enforceGroupGate` or a manual membership change. Making group sync
  demote is a product decision with its own blast radius (a transient Graph
  outage would mass-demote), not a security fix.

- **No rate limiter was added.** It would have to live inside
  `authenticateScimRequest` to produce SCIM-shaped 429s and to key on the token
  rather than a shared NAT IP — Edge middleware has no Prisma and would answer
  in the wrong content type. That is a worthwhile follow-up, and it is
  orthogonal to escalation: it changes how *fast* a valid token can act, not
  what it is allowed to do.

- **Severity was prospective when this landed.** Production held zero live SCIM
  tokens, zero identity providers, zero `ScimGroup` rows, zero ADMIN group
  mappings and zero `UserIdentityLink` rows, so there was no migration, no
  compatibility window and nothing to re-issue. Both zeros flip on the same day
  a customer turns on Entra SSO + SCIM.
