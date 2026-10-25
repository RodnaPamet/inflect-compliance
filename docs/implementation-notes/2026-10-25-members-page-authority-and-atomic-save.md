# 2026-10-25 — Members page: AI admin endings, last-admin removal, all-or-nothing role save

**Commit:** `fix(members): AI admin endings are Owner-only, the last admin cannot be removed, a role save is all or nothing` (#4118)

## Design

Three server rules on the members page's usecases (`src/app-layer/usecases/tenant-admin.ts`), each found while
writing the page's help guide:

```
PATCH /admin/members/:id { role, customRoleId }
  route ── both present ──► updateTenantMemberRoleAndCustomRole   (new)
        ── role only ─────► updateTenantMemberRole
        ── customRoleId ──► assignCustomRole

updateTenantMemberRoleAndCustomRole, one runInTenantContext:
  findActiveMembership
  assertRoleChangeAllowedInTx        (tenant-admin.ts — the role change's own checks)
  assertCustomRoleAssignableInTx     (custom-roles.ts — against the role it is about to hold)
  update { role }                    (tenant-admin.ts — the AI_ADMIN writer stays here)
  writeCustomRoleInTx                (custom-roles.ts — the customRoleId writer stays there)
  logRoleChange, logCustomRoleChange (after both writes)
```

- **All or nothing.** The route ran the two usecases one after the other, each in its own transaction, so a custom
  role the caller may not grant, or one deleted since the page loaded, was refused after the role had committed.
  Every check of both halves now runs before either write. The single-field paths are unchanged: each usecase was
  split into its checks, its write and its audit, and the combined path calls the same three parts.
- **Ending an owner-managed membership.** `assertMayEndMembership` asks `admin.owner_management` before deactivating
  or removing a membership whose role is in `OWNER_MANAGED_ROLES` (OWNER, AI_ADMIN). It is the OWNER guard the two
  usecases already had, widened to the list the role change reads, with a named reason
  (`OWNER_MANAGED_MEMBERSHIP_END_REFUSAL`) on both.
- **Last ACTIVE ADMIN.** `assertNotLastActiveAdmin` is the count the role change and deactivation each wrote inline;
  removal now asks it too, for an ACTIVE target only, as the last-OWNER rule does.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/tenant-admin.ts` | The combined usecase; the role change split into request checks, tx checks and audit; the two shared guards |
| `src/app-layer/usecases/custom-roles.ts` | `assignCustomRole` split into `assertCustomRoleAssignableInTx`, `writeCustomRoleInTx`, `logCustomRoleChange` |
| `src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts` | Dispatches a two-field body to the combined usecase |
| `src/lib/roles.ts` | `OWNER_MANAGED_MEMBERSHIP_END_REFUSAL`, `ownerManagedMembershipEndMessage` |
| `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx` | Offers neither ending on an owner-managed row to a non-Owner, nor on one's own row; hides an empty menu |

## Decisions

- **Two writes in one transaction, not one combined `update`.** A single `data: { role, customRoleId }` would put a
  `customRoleId` write in `tenant-admin.ts`, which the customRoleId-writer census
  (`tests/unit/owner-custom-role.test.ts`) refuses, and the role write belongs to `tenant-admin.ts`, the AI_ADMIN
  writer the census in `tests/unit/ai-admin-role-writers.test.ts` names. Keeping each write in its own file keeps both
  censuses true. No intermediate row can break the built-in-scope CHECK: the checks refuse every combination that
  would.
- **Audit rows after both writes.** `logEvent` appends on its own connection, so an audit row written between the
  two writes would survive a rollback of the first and narrate a change that never committed.
- **The OWNER sentences are unchanged.** `ownerManagedMembershipEndMessage` returns the OWNER wording the docs and
  tests already quote; only AI_ADMIN gets a new sentence. Both now carry the reason code, which the OWNER refusal did
  not. There is no `AUTHZ_DENIED` row: the OWNER guard never wrote one, and this rule mirrors it.
- **SCIM deprovisioning is untouched.** `isScimStatusProtectedRole('AI_ADMIN')` stays false (owner decision,
  2026-10-18): an identity provider switching an AI admin off is a different act from an ADMIN doing it on this page.
