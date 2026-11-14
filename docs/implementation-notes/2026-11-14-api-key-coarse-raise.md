# 2026-11-14 — API-key coarse tier: a baseline, raised per request

**Commit:** `fix(security): raise an API key's coarse tier per request behind a passed granular gate (#5306)`

## Design

An API key's context carries a granular `appPermissions` set (its scopes,
`scopesToPermissions`) and a coarse tier (`ctx.role` + `ctx.permissions`)
derived from the same scopes by `keyAuthorityFromScopes`: `*` and `admin:write`
give ADMIN, any other `:write` or `:*` gives EDITOR, the rest READER. So an
`admin:*` key, whose scopes grant a superset of `admin:write`'s, read EDITOR:
it passed `requirePermission('admin.manage')` on `POST /admin/api-keys` and was
refused by the usecase's `assertCanAdmin`.

Owner decision (2026-11-14, #5306 item 3): keep the scope-derived tier as the
key's baseline (the decision's "ceiling"), and when a route's
`requirePermission(<keys>)` passes for an API-key context, raise the coarse
tier for that request to the lowest built-in role holding the passed key(s).

```
getTenantCtx ─▶ assertPermission(keys) ─▶ raiseApiKeyCoarseTier(ctx, keys, mode) ─▶ handler(ctx')
                 (unchanged)                (new; API-key contexts only)
```

The raise is a new context object handed to the handler. Nothing is stored on
the key or cached, so the next request starts from the baseline again, and a
coarse-only route (`/audit-log`, `/audit-log/verify`) never sees a raise.

## Files

| File | Role |
| --- | --- |
| `src/lib/security/api-key-coarse-raise.ts` | `lowestBuiltInRoleHolding`, `raiseApiKeyCoarseTier` |
| `src/lib/security/permission-middleware.ts` | calls the raise after `assertPermission`, passes the result to the handler |
| `src/lib/auth/api-key-auth.ts` | `isReadClassScopeGroup`; `scopesToPermissions(…, { readClassGroups: 'exclude' })` |
| `src/lib/tenant-context.ts` | exports `coarseRoleLevel`, so the raise reads the one ladder |
| `tests/unit/api-key-coarse-raise.test.ts` | route-level and unit cases |

## Decisions

- **No raise from a read-class grant.** The decision's rule, read literally,
  raises `admin:read` to ADMIN behind `admin.view`, because ADMIN is the lowest
  built-in role holding `admin.view`. `admin.view` gates
  `POST /agent-runs/:id/abort` and the agent-proposal approve, reject and
  compose routes, whose usecases ask `assertCanWrite`. The literal raise would
  let a read-only key abort runs and decide proposals, which breaks the same
  decision's binding rule that no key gains reach beyond its scopes. So a
  passed key raises only when the scopes grant it through a group that is not
  `read` and not a `*_view` named group (`isReadClassScopeGroup`). `admin:*`
  still raises on `admin.manage` (its write group) and not on `admin.view`.
- **Not for an agent-bound key.** Its context was narrowed to its principal
  (`resolveAgentAuthority`), and the principal's own coarse tier is not on the
  context, so a raise could lift it above the person it speaks for.
- **`any` raises to the smallest role holding any passed key; `all` to the
  smallest holding every one.** Both are the least raise the request earned.
- **Only upward, and exactly `computePermissions(role)`.** A key's baseline is
  READER, EDITOR or ADMIN, and every raise target is strictly higher on the
  ladder, so the result is a superset of the baseline and never more than the
  target role grants.
- **Which requests change.** For a key with no agent binding, the tier is
  raised exactly when the route's gate names a key `K` that the key's scopes
  grant through a non-read group and the lowest built-in role holding `K`
  (ADMIN for every such key today) sits above the key's baseline. Today that
  is: `admin.manage`, `admin.members`, `admin.scim` (and `admin.sso`, no route)
  for `admin:*`; `incidents.manage` for `incidents:admin` / `incidents:*`;
  `personnel.manage` for `personnel:admin` / `personnel:*`;
  `access_reviews.create` / `.close` for `access_reviews:admin` / `:*`;
  `identity_reconciliation.confirm` for `identity_reconciliation:admin` / `:*`;
  `audits.manage` for `audits:write` / `audits:*`; and, with no route gated on
  them today, `policies.approve`, `frameworks.install`, `audits.freeze`.
