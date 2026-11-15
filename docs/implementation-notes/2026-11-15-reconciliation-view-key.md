# 2026-11-15 — The view key opens the reconciliation queue (#5695)

**Commit:** see the branch `claude/recon-view-key-5695`

Owner decision, 2026-11-15: holding `identity_reconciliation.view` is enough to
open the legacy-access reconciliation queue. Decisions stay on their existing
keys (`identity_reconciliation.confirm`, OWNER and ADMIN).

## Design

Every built-in role holds the view key. Before this change a holder who was not
an OWNER or ADMIN met four gates, each measured with the real code first:

| Gate | Before | After |
| --- | --- | --- |
| Edge, page path `/t/:slug/admin/integrations/:id/reconciliation` | `checkAdminAccess` = `deny`, but a refused admin PAGE falls through to the App Router (status 200) | unchanged |
| Client admin layout | no row in `ADMIN_PAGE_REQUIREMENTS`, so `membershipOpensAdminConsole` refused every role but OWNER/ADMIN | a row: `identity_reconciliation.view`, all six membership roles |
| Edge, API `GET …/admin/legacy-access/queue` | 403 `Admin access required` | admitted for EDITOR/READER/AUDITOR/AI_ADMIN, GET/HEAD, exact template |
| Route key of the run lookup `…/admin/integrations/:id/executions/latest` | `admin.manage` | page no longer calls it; new `GET …/admin/legacy-access/queue/latest-run` takes the view key |

The page is now a server component that applies `gateAdminPage` with that row
and renders `ReconciliationQueueClient` (the former page body). A row in the
table must belong to a server-gated page (`admin-layout-guard`), and the server
gate also refuses a custom role that withholds the key before anything renders.

## Files

| File | Role |
| --- | --- |
| `src/lib/auth/guard.ts` | `RECONCILIATION_VIEW_READ_PATHS`, `RECONCILIATION_VIEW_EDGE_ROLES`, `isReconciliationViewReadPath`, one branch in `checkAdminAccess` |
| `src/app/api/t/[tenantSlug]/admin/legacy-access/queue/latest-run/route.ts` | the view-scoped run lookup |
| `src/app-layer/usecases/legacy-reconcile-run.ts` | asserts the view key; legacy connections only; four fields of the run |
| `src/lib/security/route-permissions.ts` | rule for the new route |
| `src/app/t/[tenantSlug]/(app)/admin/_lib/admin-page-requirements.ts` | the page's row |
| `…/reconciliation/page.tsx`, `ReconciliationQueueClient.tsx` | server gate + client body |

## Decisions

- **Edge allowlist, not a move out of `/admin`.** The queue API sits under
  `/api/t/:slug/admin/` either way, so a move would still need the edge change
  for the API and would add a redirect, nav and help-route churn. The page path
  needed no edge change at all.
- **The edge roles are spelled out**, because `guard.ts` runs at the edge and
  stays free of the permission tables; `tests/unit/reconciliation-view-key-edge.test.ts`
  holds the set equal to `getPermissionsForRole`.
- **Legacy connections only.** The new read 404s any other provider, so the
  view key does not become a way to read the names of a tenant's other
  integrations.
- **The admin `executions/latest` route is unchanged** (`admin.manage`) and still
  serves the connection's runs card.
- **What the widening exposes.** The queue response carries candidate employees'
  names and work emails (`readQueuePeople`, #4871). `personnel.view` became
  OWNER/ADMIN only on 2026-10-29; until this change the edge kept the queue to
  the same two roles. It is now readable by every role that holds the view key.
