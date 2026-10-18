# 2026-10-18 — AI_ADMIN role, deploy 2 of 2 (assignable)

**Commit:** `feat(agentic): AI_ADMIN assignable — OWNER on the members page, Entra group mappings (2a deploy 2)`

Issue #3699, part of step 2a (#3669) of the agentic IAM roadmap. Deploy 1
(#3713, `2026-10-18-ai-admin-role-deploy-1.md`) shipped the value read-only.
This deploy gives it exactly the two writers the owner decided on 2026-10-18.

## Design

```
                       MEMBER_ROLE_CHANGE_ROLES (writers' list + AI_ADMIN)
  members page ──PATCH──▶ updateTenantMemberRole ──┐
                          into/out of: owner_management (OWNER_MANAGED_ROLES)
                          custom role on member? ─▶ 409 BUILT_IN_SCOPE_…
                                                    ├──▶ TenantMembership.role = AI_ADMIN
  Entra sign-in ──────────┐                         │     (MEMBER_ROLE_CHANGED)
  SCIM Groups push ───────┴▶ syncEntraMembershipRole┘
       ceiling: SCIM_GROUP_ASSIGNABLE_ROLES          resolveRoleFromGroups
       (Users ceiling + AI_ADMIN)                    tie vs ADMIN/EDITOR/AUDITOR ─▶ no change
                                                     custom role on member ─▶ no change
  mapping CRUD: a row whose role is/becomes AI_ADMIN ─▶ owner_management

  everything else ── ASSIGNABLE_TENANT_ROLES (unchanged, no AI_ADMIN):
  invites + both redemptions · direct add · access-review MODIFY + close ·
  custom-role base · SCIM roles[] · SSO JIT
```

The shared writers' list was deliberately NOT widened. Six writers read it,
and the owner wanted every one of them still refusing; appending the value
there and re-narrowing five call sites is the shape that drifts. The role
change reads its own list, and the census pins that list's consumers by name.

## Files

| File | Role |
|---|---|
| `src/lib/roles.ts` | `MEMBER_ROLE_CHANGE_ROLES`, `OWNER_MANAGED_ROLES`, `BUILT_IN_SCOPE_ROLES` + `mayCarryCustomRole`, the refusal messages and named reason |
| `src/app-layer/usecases/tenant-admin.ts` | The role change: its list, the OWNER-only gate both ways, the custom-role refusal |
| `src/app-layer/usecases/custom-roles.ts` | `assignCustomRole` refuses an AI_ADMIN membership; clearing stays allowed |
| `src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts` | Validates against the role change's list; refuses AI_ADMIN + a custom role in one body |
| `src/lib/auth/entra-role-mapping.ts` | AI_ADMIN ranked against READER only (`TIE_DECIDABLE_AGAINST`), `ambiguousGroupIds`; `NEVER_GROUP_MAPPED_ROLES` now `['OWNER']` |
| `src/lib/auth/entra-group-sync.ts`, `src/lib/observability/metrics.ts` | The custom-role hold and the ambiguous tie, each a no-write outcome with its own metric value |
| `src/app-layer/schemas/entra-group-mapping.schemas.ts` | `ENTRA_MAPPABLE_ROLES` gains AI_ADMIN |
| `src/app-layer/usecases/entra-group-mappings.ts` | Create/update/delete of an AI_ADMIN mapping is OWNER-only |
| `src/lib/scim/roles.ts`, `src/app-layer/usecases/scim-groups.ts` | `SCIM_GROUP_ASSIGNABLE_ROLES` for the Groups push; the Users ceiling unchanged |
| `admin/members/page.tsx`, `admin/entra/GroupMappingsSection.tsx`, `messages/*.json` | AI admin offered to an OWNER only; labels; locked rows for an ADMIN; the custom-role and tie notices |

## Decisions

- **Refuse, never repair, the custom-role combination.** The owner offered
  "refuse or clear" for promoting a member who carries a custom role; refuse
  is the conservative one. Clearing on the caller's behalf would be a second
  change (a custom-role removal) hidden inside the first, audited as a role
  change. The same holds for the group sync, which also does not clear it:
  `custom_role_held` writes nothing. One named reason,
  `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`, on a 409 with `details.reason`.
  It is built from a list (`BUILT_IN_SCOPE_ROLES`), not a literal, so the rule
  names the property, not the role.
- **The OWNER-only gate extends to mappings.** "An ADMIN cannot assign or
  remove AI_ADMIN" would be false if an ADMIN could create a mapping to it — the
  mapping routes take `admin.manage`, which ADMIN holds. So creating, changing
  (including re-prioritising) or deleting a mapping whose role is or becomes
  AI_ADMIN takes `admin.owner_management`. Residual, documented in the usecase:
  an ADMIN can still re-prioritise ANOTHER mapping above an AI_ADMIN one. Gating
  every mapping write on whether some AI_ADMIN mapping exists would make the
  whole table OWNER-only.
- **Group-resolution precedence: priority decides; seniority breaks a tie only
  where nothing is lost.** The resolver's order is priority, then seniority,
  then group id. AI_ADMIN is not on the seniority ladder: it is READER's set
  plus the agent keys, so it contains READER and wins that tie; against ADMIN,
  EDITOR and AUDITOR each side holds a grant the other lacks (ADMIN lacks only
  `admin.agent_ownership`), so either winner would silently strip a grant the
  tenant mapped on purpose. Such a top-priority tie yields no role and leaves
  the membership as it is, metric `ambiguous_tie`; the UI says so when AI admin
  is picked. The allowlist form (`TIE_DECIDABLE_AGAINST`) makes a future role
  undecidable against AI_ADMIN by default. No existing tenant's resolution
  changes: no AI_ADMIN mapping could exist before this deploy, and the five
  ladder roles keep their relative order.
- **`NEVER_GROUP_MAPPED_ROLES` kept, holding OWNER.** It was the read-side half
  of the schema's exclusion; with AI_ADMIN mappable it would have gone empty,
  but the schema still excludes OWNER and the resolver used to promote a stored
  OWNER row on the sign-in path. A test pins it as the exact complement of
  `ENTRA_MAPPABLE_ROLES`.
- **The SCIM Groups ceiling is the Users ceiling plus AI_ADMIN, derived.** The
  owner asked for the role on both group paths. The Groups push's ceiling also
  bounds which memberships it may touch, so the push that moves a member in can
  move them out. The Users path is unchanged: `roles[]` never confers it, and
  `isScimProtectedRole` still treats an AI_ADMIN membership as untouchable from
  `/Users`. The #2200 exposure applies: a holder of the SCIM bearer token can
  push a group carrying the AI_ADMIN-mapped group's id.
- **The members page locks an AI_ADMIN row for a non-OWNER** rather than
  opening an editor in which every save is refused. OWNER rows keep their
  existing behaviour.
- **An access review can still MODIFY an AI_ADMIN subject to another role.** It
  never promotes to it (`ASSIGNABLE_TENANT_ROLES`), but removing access is the
  campaign's purpose, and it can already demote an OWNER under the last-OWNER
  guard. The owner's gate covered the members page; the review's closer holds
  `access_reviews.close`.
