# 2026-10-29 — The people layer is readable by Owners and Admins only

**Commit:** `<sha> fix(permissions): personnel.view is held by OWNER and ADMIN only`

Owner decision, 2026-10-29: only Owners and Admins hold `personnel.view`.

## Design

`personnel.view` was granted to every built-in role when the people layer
landed (PR-4, `2026-07-07-pr4-personnel-hris.md`). The pages that show the
data (`/admin/personnel`, `/admin/devices`, `/admin/training`) sit under the
admin console, which the edge and the admin layout restrict to Owners and
Admins. The API reads did not: they sit outside `/api/t/:slug/admin/` and gate
on `personnel.view` alone, so any member could read the employee roster,
devices, training assignments and background checks over the API.

The change is to the role defaults only. `getPermissionsForRole` now returns
`personnel: { view: false, manage: false }` for EDITOR, AUDITOR and READER,
and AI_ADMIN inherits READER's value. OWNER and ADMIN are unchanged.
`personnel.manage` was already OWNER/ADMIN only. No route, usecase or schema
behaviour changed; the key that every reader consults is the one that moved.

```
key: personnel.view
  GET /api/t/:slug/personnel           requirePermission  → 403 + AUTHZ_DENIED for non-admins
  GET /api/t/:slug/devices             requirePermission  → same
  GET /api/t/:slug/training            requirePermission  → same
  GET /api/t/:slug/background-checks   requirePermission  → same
  compliance calendar, source `training`   per-source filter → omitted for non-admins
                                           (also in each member's pushed calendar)
  MCP get_tenant_context recentActivity    per-row redaction → Employee rows dropped
                                           for a context without the key
```

## Files

| File | Role |
| --- | --- |
| `src/lib/permissions.ts` | The defaults: EDITOR, AUDITOR and READER (and so AI_ADMIN) lose `personnel.view` |
| `tests/unit/personnel-view-owner-admin-only.test.ts` | Role matrix, the four GET routes per role, custom-role and API-key behaviour |
| `tests/unit/ai-admin-permissions.test.ts` | AI_ADMIN's key-by-key table follows the decision |
| Comments in the manager route, the identity-reconciliation policy, the api-permission guardrail and `custom-roles.test.ts` | They stated that every role held the read |

## Decisions

- **Defaults, not stored grants.** Every custom-role create and update runs
  `validatePermissionsJson`, which requires every action of every domain, so a
  stored role carries an explicit `personnel.view`. Such a role keeps exactly
  what it says, including a Reader-based role saved from the Reader preset
  before today, which states `view: true`. Only a blob with no `personnel`
  domain (written before PR-4) reads its base role's default, which is now
  `false` on every base except ADMIN. No migration rewrites stored roles: a
  stored grant was an Admin's decision, and it stays visible and editable on
  the Roles page.
- **API keys are unaffected.** `scopesToPermissions` starts from all-false and
  sets what the scopes name. `personnel:read` and `*` still carry the read.
  An agent's effective set is its member's set intersected with its key's, so
  an agent acting for a non-admin member loses the read along with that
  member.
- **No usecase-layer check was added.** The four list usecases carry none,
  and their only callers are the four routes and the three admin pages. A
  usecase-layer `assertCan*` would not replace the route gate, and the admin
  pages are gated by the admin console. The jobs and identity, JML, HRIS and
  access-review code read the `Employee`, `Device` and training tables
  directly under their own keys or system contexts, and none of them consults
  `personnel.view`.
- **The routes are not added to `PRIVILEGED_ROOTS`.** Their gate is already a
  literal `requirePermission`. Registering the people-layer directories would
  need `ROUTE_PERMISSIONS` rules and a token-auth exclusion for
  `devices/report`, which is a separate change.
