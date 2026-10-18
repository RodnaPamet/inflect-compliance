# 2026-10-18 — Edge admin gate judges the URL tenant's role (#3701)

**Commit:** `fix(auth): judge the edge admin gate by the role in the URL's tenant`

## Design

Gate 3 of `src/middleware.ts` (admin paths) read `token.role`, which
`src/auth.ts` sets from the session's primary (oldest) membership. R-1 made the
tenant-access gate (gate 5) multi-tenant, but gate 3 still answered for the
first tenant whatever tenant the URL named:

- READER in A, OWNER in B → refused every admin API in B. It failed closed, but
  locked a legitimate admin out of every tenant except their first.
- OWNER in A, READER in B → passed gate 3 in B. The handler's
  `requirePermission` refused it, so nothing was exposed, but the edge was
  admitting on a fact about the wrong tenant.

`checkAdminAccess(pathname, primaryRole, memberships)` in
`src/lib/auth/guard.ts` replaces the inline check:

| path | judged by | result |
| --- | --- | --- |
| `/t/:slug/admin/**`, `/api/t/:slug/admin/**`, slug in the claim | that entry's `role` | `allow` / `deny` |
| tenant admin path, slug NOT in the claim | nothing; gate 5 decides | `defer` |
| flat `/admin` page | `token.role` | `allow` / `deny` |

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/guard.ts` | `EDGE_ADMIN_ROLES`, `checkAdminAccess` (pure) |
| `src/middleware.ts` | gate 3 calls it; `deny` behaves exactly as before |
| `tests/integration/middleware-admin-gate.test.ts` | behavioural, through `middleware()` |
| `tests/unit/guard.test.ts` | the pure function's table |
| `docs/auth.md` | gate 3's description |

## Decisions

- **A slug missing from the claim is `defer`, not `deny`.** Gate 5 already owns
  that answer. It refuses `cross_tenant` when the claim is complete, and defers
  to the DB-backed server gate when `membershipsTruncated` says a membership may
  not have fit in the cookie. A `deny` here would re-create, for admin paths
  only, the lockout that the truncation flag exists to prevent.
- **A deferred admin API request still gets the Sec-Fetch-Site check.** Being
  stricter on a request whose role the edge could not read costs nothing.
- **`deny` keeps both of its old responses.** The API gets a 403 with
  `Admin access required`. A page proceeds to the layout guard's
  `<ForbiddenPage>` and is not redirected, because of the dev-server crash the
  middleware comment records.
- **The flat `/admin` page keeps the primary role.** It names no tenant, so
  there is no other role to read. `/api/admin` is a machine-caller prefix
  (platform key) and never reaches gate 3.
- **Custom roles are untouched.** The edge sees only the built-in base role. A
  custom role that grants admin keys over a READER base is still refused at the
  edge, as before. Widening the edge set is #3699's question (`AI_ADMIN`), and
  this change is what makes a per-tenant answer to it meaningful.
