# 2026-10-29 — Admin server pages gate on the server

**Commit:** `fix(security): gate every admin server page on the server before it reads`

## Design

`src/app/t/[tenantSlug]/(app)/admin/layout.tsx` is a client component. Its
`<RequirePermission resource="admin" action="view">` decides what the browser
shows, but it runs after the server-component pages below it have rendered, and
their props are already serialized into the RSC payload. The edge does not
refuse an admin page request either: for a page, `checkAdminAccess` returning
`'deny'` falls through to the App Router. So a server page that read data and
relied on the layout sent that data to any member of the tenant who opened its
URL, with "Access denied" on screen.

A server check in the layout would not have been enough on its own, because a
layout does not re-render on client navigation between its children. The check
is therefore per page:

```
page.tsx (server)
  const gate = await gateAdminPage('<own route>', params);   ← getTenantCtx + requirement
  if (!gate.allowed) return gate.forbidden;                  ← the layout's ForbiddenPage, nothing read
  …reads with gate.ctx…
```

`gate.ctx` exists only on the admitted branch of the union, so a page cannot
reach its context without testing `allowed`.

What each page requires is one table, `ADMIN_PAGE_REQUIREMENTS`, in a pure
module beside the gate. The floor is `admin.view`, the layout's own rule, so
nobody the screen refuses receives the page's data. On top of it goes the key
the same rows are read under elsewhere (their API route, or the usecase's own
assertion). The audit log is the one exception: by owner decision it takes
exactly `canAudit`, so an AUDITOR's render reads it, while the client layout
still hides the page on screen.

Reads used only by admin surfaces now also assert their route's key in the
usecase (`listEmployees`, `listDevices`, `listTrainingAssignments` →
`personnel.view`; `getTrustCenter` → `admin.manage`).

## Files

| File | Role |
| --- | --- |
| `admin/_lib/admin-page-requirements.ts` | The per-page requirement table and the pure `admitsAdminPage` check |
| `admin/_lib/admin-page-gate.tsx` | `gateAdminPage`: resolves the context, applies the row, returns the context or the forbidden page |
| `admin/**/page.tsx` (17 server pages) | Call the gate as their first statement |
| `admin/rbac/page.tsx`, `admin/billing/page.tsx` | Also drop their own `auth()` + `resolveTenantContext`, using the gate's context |
| `admin/audit-log/page.tsx` | Gate on `canAudit`; no longer swallows the read's refusal into an empty table |
| `usecases/personnel.ts`, `device.ts`, `training.ts`, `trust-center.ts` | Assert the route's key before the read |
| `admin/layout.tsx`, `src/middleware.ts` | Comments only: they claimed the layout was the boundary |
| `tests/guardrails/admin-layout-guard.test.ts` | Gains the structural rule over every admin `page.tsx` git lists, beside its existing layout checks |

## Decisions

- **A call, not a wrapper.** A higher-order `adminPage(route, handler)` would make
  "nothing runs before the gate" true by construction, but would re-indent every
  page body. The call keeps each diff to a few lines, and the guardrail reads the
  AST to assert that the call is the FIRST statement, that the refusal is the
  second, that the route literal is the page's own folder path, and that the
  function is imported from the real module.
- **Keyed by route, checked against the path.** A page passes its own route to the
  gate, so the requirement it gets is the one written for it. The guardrail
  refuses a page that names another page's row. Without that, a copied
  `gateAdminPage('/admin', …)` would pass every structural check while applying
  the hub's rule to the member list.
- **The guard lives in `admin-layout-guard.test.ts`, not a file of its own.** That
  file already ranges over the same population (every admin `page.tsx`), and a
  new file would have pushed `tests/guards` + `tests/guardrails` to the ceiling
  that `no-epic-named-ratchets.test.ts` holds. Folding into the guard that owns
  the population is the practice that ceiling asks for.
- **Pages that read nothing are gated too.** The hub and the four vendor pages
  read nothing on the server. Gating them costs one context resolution, and it
  means the only exemption class is redirect-only pages. Each of those is verified
  to await only `params` and call only `redirect`. A read added to a gated page
  later is behind the gate from its first line.
- **No AUTHZ_DENIED row on a page refusal.** The existing server-page gates (the
  `/agents/*` pages) render a forbidden page without auditing, and the API routes
  behind every page audit through `requirePermission`. Auditing a page view is a
  separate decision.
- **The layout is unchanged.** It remains the on-screen guard. Opening the audit
  log to AUDITORs on screen is a separate change; this one only narrows.
- **`personnel.view` is still every role's.** The roster, device and training
  routes admit every built-in role by design. The usecase checks add a layer for
  custom roles, not a narrowing for built-in ones.
