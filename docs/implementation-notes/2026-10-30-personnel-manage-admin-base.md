# 2026-10-30 — `personnel.manage` only on an Admin-based custom role

**Commit:** see PR for #4536

## Design

Owner decision (2026-10-30), option (a): only a custom role based on ADMIN may hold `personnel.manage`.

The background: #4503 made the roster read (`personnel.view`) Owner- and Admin-only, and #4520 switched the stored read off on Reader-, Editor- and Auditor-based custom roles. Neither touched `manage`, so a role stored with `manage: true` on one of those bases could create roster records it could not list.

- `src/lib/personnel-manage-rule.ts` (client-safe) holds the rule, `mayHoldPersonnelManage(baseRole)`, and the refusal reason `PERSONNEL_MANAGE_NEEDS_ADMIN_BASE`.
- `createCustomRole` refuses it. `updateCustomRole` refuses it on the *resulting* role, whenever the update writes the permissions or the base role.
- The Roles page:
  - locks the cell on a non-Admin base, with its own hint;
  - keeps presets and a base-role change from setting it;
  - names a legacy role that still holds it and holds **Save**;
  - re-says the server's refusal in the page's own words.
- Migration `20261030130000_personnel_manage_off_for_non_admin_custom_roles` switches the stored grants off. It is the same shape as #4520's, for the same reasons: an allowlist base filter, inactive rows included, and an idempotent `jsonb_set` on one key.

## Decisions

- **A rename of a legacy role is not refused.** The rule is checked only when the update writes `permissionsJson` or `baseRole`, so a role the migration somehow missed can still be renamed. The page holds Save for it anyway, until the grant is switched off.
- **`view` is not refused on other bases.** The decision covers `manage`. A custom role on any base may still grant the roster read, as the `personnel` docblock in `permissions.ts` says.
- **No database CHECK.** As with #4520, the usecase is the only writer of `TenantCustomRole.permissionsJson`, and the migration clears what is stored.
