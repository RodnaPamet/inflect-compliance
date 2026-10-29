# 2026-10-29 — Stored custom roles stop granting the people layer to non-admins

**Commit:** `<sha> fix(permissions): switch personnel.view off on stored non-admin custom roles`

Owner decision, 2026-10-29: only Owners and Admins read the people layer, and
custom roles built from the Reader, Editor or Auditor preset lose the grant
they stored, by a one-off data migration.

## Design

#4503 (`2026-10-29-personnel-view-owner-admin-only.md`) moved the role
defaults: `getPermissionsForRole` returns `personnel.view: false` for EDITOR,
AUDITOR and READER. A custom role does not read those defaults for a key it
states. `parsePermissionsJson` takes a stored boolean over the base role's
default, and `validatePermissionsJson` requires every action of every domain on
create and update. So every role saved since the people layer existed states
`personnel.view`, and one built from a non-admin preset before #4503 states it
as `true`. Its members would have kept reading the roster, devices, training
and background checks.

The migration `20261029220000_personnel_view_off_for_non_admin_custom_roles`
is one statement:

```
UPDATE "TenantCustomRole"
   SET permissionsJson.personnel.view := false   (jsonb_set, nothing else in the blob)
       updatedAt := now
 WHERE baseRole IN (READER, EDITOR, AUDITOR)
   AND permissionsJson.personnel.view is the JSON boolean true
```

| Stored row | Result |
| --- | --- |
| READER / EDITOR / AUDITOR base, `view: true` | `view: false`. `manage` and every other key unchanged |
| the same, `isActive = false` (soft-deleted) | the same |
| ADMIN base | untouched |
| no `personnel` domain (pre-PR-4 blob) | untouched; it reads its base default, `false` since #4503 |
| `view` already `false`, or not a boolean | untouched; a non-boolean reads the base default |
| legacy OWNER / AI_ADMIN base (#3734 CHECK left NOT VALID) | untouched |

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261029220000_personnel_view_off_for_non_admin_custom_roles/migration.sql` | The data migration |
| `tests/integration/personnel-view-custom-role-migration.test.ts` | Runs the migration's own SQL against seeded rows in two tenants: what changes, what does not, a second run, and the NOT VALID CHECK case |

## Decisions

- **The base filter is an allowlist.** `baseRole <> 'ADMIN'` would say the same
  thing on a clean table. The #3734 CHECK
  (`TenantCustomRole_base_role_not_built_in_scope`) keeps OWNER and AI_ADMIN off
  a custom role's base. Where that migration found legacy rows, it left the
  CHECK NOT VALID, and a NOT VALID CHECK still refuses any UPDATE that keeps
  such a row's base. A negative filter would update those rows. One refused row
  fails the migration, and `entrypoint.sh` re-runs `migrate deploy` on every
  container start, which is the P3009 restart-loop shape of #2745. The
  integration test reproduces that state and shows the shipped statement
  passes it.
- **One key, by `jsonb_set`.** The column is `JSONB` (it was created that way in
  `20260418092219_add_tenant_custom_roles`). `create_missing` is `false`, and
  the predicate already requires the key, so the path cannot add a domain to a
  blob that never had one.
- **Matched on the JSON boolean `true`.** `parsePermissionsJson` honours only a
  boolean, so a string `"true"` was never a grant, and the statement leaves it
  alone.
- **Soft-deleted rows are included.** The product cannot restore a custom role:
  `deleteCustomRole` sets `isActive = false`, the Roles page lists active roles
  only, `updateCustomRole` writes no `isActive`, and assignment requires an
  active role. Including the rows costs nothing, and a restore added later, or
  done by hand, would otherwise bring the grant back.
- **`personnel.manage` is left alone, by the owner's decision.** Nothing in the
  product keeps `manage` off a non-admin base. The preset buttons fill the grid
  whatever the base is, editing a role's base does not reset its grid, and the
  grid toggles `manage` directly. The author-authority check compares the grid
  with the AUTHOR's permissions, not with the base role's. So a READER-, EDITOR- or
  AUDITOR-based role may store `manage: true`. After this migration it holds
  `manage` without `view`: it can still create employees, training and
  background checks, and cannot list them.
- **`updatedAt` is stamped.** Prisma's `@updatedAt` is set by the client, so a
  row changed from SQL would otherwise keep a timestamp from before the change.
  The predicate is what makes the statement idempotent, and a changed row no
  longer matches it, so a re-run stamps nothing.
- **No audit row.** The audit trail is hash-chained and written only through
  `logEvent`. The change shows up on the Roles page: the role's Personnel `view`
  box is unticked, and its granted-permission count is one lower. The API
  response's `updatedAt` carries the deploy time. An Admin who wants the grant
  back ticks the box, which goes through `updateCustomRole` and writes
  `CUSTOM_ROLE_UPDATED`.
- **Ships with or after #4503.** If this migration ships alone, a custom role
  based on READER, EDITOR or AUDITOR loses a read that a plain member of the
  same base still has. That is narrower than either side alone and breaks
  nothing.
