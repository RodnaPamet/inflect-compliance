# 2026-10-30 — Admin-base-only permissions for custom roles

**Commit:** see the PR for #4581 A

## Design

A custom role's base role is what every coarse-tier check reads
(`computePermissions(baseRole)` → `canAdmin`). Several admin routes check a
granular key (`requirePermission('admin.manage')`), and the usecase behind them
then calls `assertCanAdmin`. A custom role built on Reader, Editor or Auditor
that granted the key therefore passed the route and was refused by the usecase,
with no `AUTHZ_DENIED` row. The Custom roles and Integrations pages are where
it was found (#4466 item 9, #4467 item 6).

Owner decision (2026-10-30): refuse the combination, as #4536 already did for
`personnel.manage`, and migrate stored roles. That rule is generalised:

```
src/lib/custom-role-admin-base-rule.ts   (client-safe)
  ADMIN_BASE_ONLY_PERMISSIONS   admin.manage, admin.members,
                                admin.owner_management, admin.tenant_lifecycle,
                                personnel.manage
  ADMIN_KEYS_ON_ANY_BASE        every other admin key, each with its reason
        │
        ├── createCustomRole / updateCustomRole → 400 PERMISSION_NEEDS_ADMIN_BASE
        │                                         details.permissions = [keys]
        ├── Roles page: cells locked on other bases, presets and base moves
        │   switch them off, a legacy role is told which and cannot be saved
        └── migration 20261030150000: switch the four admin keys off on
            READER / EDITOR / AUDITOR roles (personnel.manage was 20261030130000)
```

## Decisions

- **The list is per key, from the server code.** A key is on it when server
  code behind a route gated on it asks the Admin tier: `admin.manage` (most of
  its routes), `admin.members` (member, invite, custom-role assignment and
  session usecases), `admin.owner_management` (read inside those same
  usecases), `admin.tenant_lifecycle` (two routes: external prior-state read,
  MCP server token). The rest of the admin keys are allowed on any base, and
  `ADMIN_KEYS_ON_ANY_BASE` says why for each. A unit test fails until a new
  admin key is put in one list or the other.
- **`admin.view` stays allowed on any base.** It also gates agent runs and
  proposals, which sit outside `/admin`, are not refused at the edge, and make
  no Admin-tier check. A Reader-based "agent reviewer" role is a real use. The
  admin pages are closed to a non-Admin membership by #4581 B in any case.
- **`admin.tenant_lifecycle` is on the list although most of its routes would
  work.** Two of them ask the Admin tier, so a non-Admin-base role holding it
  was let in and refused there; and it is an Owner-only key, which only an
  Owner can put in a role. The migration removes it from such roles. A role
  that needs it is based on Admin.
- **One reason code for the whole rule.** `PERSONNEL_MANAGE_NEEDS_ADMIN_BASE`
  (shipped hours earlier in #4577) becomes `PERMISSION_NEEDS_ADMIN_BASE`, with
  the keys in `details.permissions`. The Roles page reads the keys and names
  them by their labels.
- **Same migration shape as #4520 / #4536.** One statement per key, a base
  allowlist (not `<> 'ADMIN'`), only JSON `true` changes, inactive rows
  included, no audit row, forward-only. Its integration test pins that the SQL
  covers exactly the rule's admin keys.
