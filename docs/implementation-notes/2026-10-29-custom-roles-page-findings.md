# 2026-10-29 — Custom roles page: live-only role names, and the help-guide findings

**Commit:** `<sha> fix(custom-roles): a deleted role frees its name, and the page says what the server would (#4467)`

Writing the help-site guide for `/admin/roles` (#4455) turned up eleven
findings (#4467). This change fixes the nine that are defects; the other two
change who may do what and wait for a decision.

## Design

**A custom role's name is unique among LIVE roles** (owner decision,
2026-10-29). Deleting a custom role is a soft delete (`isActive` false), but the
full `@@unique([tenantId, name])` and the usecases' duplicate checks counted
deleted rows, so a deleted role's name was taken for good by a role nobody could
see. Migration `20261029190000_custom_role_name_unique_among_live` replaces the
index with a partial one under the same name, `WHERE "isActive"`, plus a plain
`(tenantId, name)` lookup index — Asset's
`20260312210616_partial_unique_soft_delete`, applied to the second soft-delete
column the schema uses. `findLiveCustomRoleByName` asks the index's exact
question for create and rename.

**The page follows the server's rules where the editor can see them:**

```
assertGrantWithinOwnAuthority          the grid
  resulting role ⊆ editor's perms  →   a permission the editor lacks cannot be
                                       switched ON; one the role already grants
                                       can be switched OFF; presets and base-role
                                       defaults start inside the editor's set;
                                       Save is held while the role exceeds it
  refusal: keys in the message     →   reason + keys in details, re-said with
                                       the grid's labels
```

The editor's permissions come from `usePermissions()` — the server-resolved,
custom-role-aware set the tenant layout puts in `TenantProvider` — so the page
stays a client component and reads nothing new.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261029190000_custom_role_name_unique_among_live/` | Full unique index → partial over live roles, plus the lookup index |
| `prisma/schema/auth.prisma` | `@@unique([tenantId, name])` → `@@index`, with the comment saying where uniqueness lives |
| `src/app-layer/usecases/custom-roles.ts` | Live-only duplicate checks; the grant refusal carries `{ reason, exceeded }` |
| `src/lib/custom-role-grant-refusal.ts` | Client-safe reason constant and reader |
| `src/app/t/[tenantSlug]/(app)/admin/roles/page.tsx` | Failed load, empty state, labels, Tooltip, held-permission rules, ConfirmDialog, breadcrumb |
| `messages/{en,bg}.json` | Action labels, two domain labels, delete copy, refusal copy |
| `docs/user/guide/admin/roles.md` | The guide, re-read against the new behaviour |

## Decisions

- **The partial index keeps the old name**, as Asset's did, so a P2002 names
  the same constraint before and after. Prisma's `migrate diff` ignores a
  partial index, so the fresh-DB drift residue does not change.
- **Delete is a ConfirmDialog, not the Epic 67 undo toast.** A custom role is
  access configuration. Deleting it changes what other people may do — each
  member goes back to the role on their own membership, which can allow more
  than the custom role did — and that has to be read before the commit, which a
  toast after the click cannot show. Re-creating the role does not give it back
  to anyone (`docs/destructive-actions.md`, "When NOT to use this pattern").
- **A permission the editor lacks is `aria-disabled`, not hidden or
  `disabled`.** Hiding it would leave a hole the grid already uses for "no such
  action", and a `disabled` button takes no hover or focus, so its Tooltip could
  never say why it is off.
- **Switching OFF a permission the editor lacks is allowed.** The server checks
  the resulting role, so it accepts a role narrowed to within the editor's own
  set; the grid offers exactly that, and no more.
- **The grid cell's hint is a Tooltip**, retiring the permission matrix as a
  `title=` density exception: at about 70 cells the cost is small, and the hint
  now names the permission in the viewer's language.
