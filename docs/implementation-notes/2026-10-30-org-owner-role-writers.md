# 2026-10-30 — ORG_OWNER, deploy 2: backfill, guard and owner-only powers

**Commit:** see the PR for #4576 deploy 2.

## Design

Deploy 1 (`2026-10-30-org-owner-role-readers.md`) shipped the value and code
that reads it. This deploy writes it, under the owner's decisions of 2026-10-30:

- **Backfill** (migration `20261030160000`): in each organization with an
  ORG_ADMIN and no ORG_OWNER, the earliest-joined ORG_ADMIN (`createdAt`, then
  `id`) becomes owner. Idempotent; an org with no admin gets no owner.
- **Last-owner guard**: the usecase refuses, and the trigger
  `org_membership_last_owner_guard` backs every other writer, raising P0001
  when an owner row is deleted or demoted and no other owner remains. The
  organization's own delete cascades through: its row is already gone when the
  trigger fires for its memberships.
- **Owner-only powers**: `canManageOwners` (promote to, demote or remove an
  owner) and `canManageTenants` (create, link and delete tenants under the
  org), both owner-only. Org delete/rename does not exist yet; it is
  owner-only when built.
- **Writers**: the role change is the one writer of ORG_OWNER, by an owner
  only (an admin's attempt is an audited `ORG_AUTHZ_DENIED`). The direct add
  and the invite never write it. `POST /api/org` makes the creator the owner;
  the seed's CISO and `scripts/add-tenant-owner.ts` follow.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261030160000_org_owner_backfill_and_guard` | Backfill and trigger |
| `src/lib/permissions.ts` | `canManageOwners`; `canManageTenants` owner-only |
| `src/app-layer/usecases/org-members.ts` | `reader_to_owner` / `admin_to_owner`; the owner-row rule read as `canManageOwners` |
| `src/app-layer/schemas/organization.schemas.ts` | The role change's schema admits ORG_OWNER; the add's does not |
| `src/app/api/org/route.ts`, `prisma/seed.ts`, `scripts/add-tenant-owner.ts` | New organizations owned; the script never demotes an owner |
| `src/app/org/[orgSlug]/(app)/members/MembersTable.tsx` | Owner offered in the role dialog to an owner only |

## Decisions

- **The backfill is not on the org audit chain.** The chain is hash-linked in
  application code, so SQL cannot append to it. The migration is the record of
  the one-time promotion; every later change is audited by its usecase.
- **ORG_ADMIN loses tenant management.** That is the owner's decision, and it is
  why the seed's CISO, the E2E portfolio user, is now the seeded org's owner.
- **The trigger mirrors the tenant one** (`tenant_membership_last_owner_guard`)
  and, like it, does not serialise two concurrent demotions of two owners; the
  usecase re-checks inside its transaction, as the tenant usecase does.
