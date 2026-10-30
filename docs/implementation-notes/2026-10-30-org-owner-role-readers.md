# 2026-10-30 — ORG_OWNER, deploy 1: the value and its readers

**Commit:** see the PR for #4576 deploy 1.

## Design

The owner asked for an `ORG_OWNER` org role (decisions of 2026-10-30): backfill
the oldest ORG_ADMIN of each organization, guard the last owner in the usecase
and with a trigger, and make owner management, org lifecycle and tenant
management owner-only.

A Prisma client meeting an enum value it was not generated with fails the whole
read, and `OrgMembership.role` is read on every org page and into the JWT. So the
value ships in two deploys, the shape `AI_ADMIN` used for `Role` (#3699):

```
deploy 1 (this)   ALTER TYPE ADD VALUE; every reader handles it; no writer
deploy 2          backfill oldest ORG_ADMIN -> ORG_OWNER; last-owner trigger;
                  owner-only flags; promotion by an owner; new orgs owned
```

Deploy 1's readers are written so that deploy 2's rolling window is safe: while
old containers still serve, the backfill has already made owners, and every old
container treats them as administrators and refuses an admin's change to them.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma`, migration `20261030140000_org_owner_role_value` | The value, declared last |
| `src/lib/org-roles.ts` | `ORG_ADMIN_TIER_ROLES`, `isOrgAdminTier`, `isOrgOwner`, `orgRoleRank` |
| `src/lib/permissions.ts` | `ORG_OWNER` resolves to ORG_ADMIN's set in this deploy |
| `src/app-layer/usecases/org-members.ts` | Owner-first ordering; owner rows changed only by an owner (audited); last-owner and last-administrator guards count owners; `owner_to_admin` moves no tenant access; the direct add refuses ORG_OWNER |
| `src/app-layer/usecases/org-provisioning.ts` | New tenants fan ADMIN to owners too |
| `src/app/org/[orgSlug]/(app)/members/*` | Owner label; an owner row's actions locked for a non-owner viewer |
| `src/auth.ts` | The JWT org membership type admits the value |

## Decisions

- **An owner is an admin, plus.** Every "is this an administrator" question asks
  `isOrgAdminTier`. A literal `'ORG_ADMIN'` comparison would have counted an
  org's only owner as no administrator at all — the last-admin guard would then
  have let its last ORG_ADMIN be removed.
- **The owner-row rule ships in deploy 1, not 2.** In this deploy nobody is an
  owner, so it refuses nothing. It exists so the old containers serving during
  deploy 2's roll cannot let an admin demote or remove a freshly backfilled
  owner.
- **`owner_to_admin` is its own transition.** The old code derived the
  transition as "from READER, else to READER", which would have fanned IN an
  owner's tenant ADMIN rows on a step down to admin.
- **The usecases refuse ORG_OWNER, not only the routes' schemas.** The direct
  add accepted any `OrgRole` once the route had validated it; with a third value
  in the enum a caller that bypassed the route would have been its first writer.
