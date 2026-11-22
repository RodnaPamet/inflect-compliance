# 2026-11-15 — The view key opens the reconciliation queue, for Auditors (#5695)

**Commit:** see the branch `claude/recon-view-key-5695`

Owner decisions, 2026-11-15, recorded on #5695:

1. Holding `identity_reconciliation.view` is enough to open the legacy-access
   reconciliation queue. Decisions stay on their existing keys
   (`identity_reconciliation.confirm`, OWNER and ADMIN).
2. Scope: **Auditors only.** The built-in roles that hold the view key are
   OWNER, ADMIN and AUDITOR. EDITOR, READER and AI_ADMIN (READER's set) held it
   until this change and no longer do; a custom role can still grant it.

## Design

Before this change a view-key holder who was not an OWNER or ADMIN met four
gates, each measured with the real code first:

| Gate | Before | After |
| --- | --- | --- |
| Edge, page path `/t/:slug/admin/integrations/:id/reconciliation` | `checkAdminAccess` = `deny`, but a refused admin PAGE falls through to the App Router (status 200) | unchanged |
| Client admin layout | no row in `ADMIN_PAGE_REQUIREMENTS`, so `membershipOpensAdminConsole` refused every role but OWNER/ADMIN | a row: `identity_reconciliation.view`, membership roles OWNER, ADMIN, AUDITOR |
| Edge, API `GET …/admin/legacy-access/queue` | 403 `Admin access required` | admitted for AUDITOR, GET/HEAD, exact template |
| Route key of the run lookup `…/admin/integrations/:id/executions/latest` | `admin.manage` | page no longer calls it; new `GET …/admin/legacy-access/queue/latest-run` takes the view key |

The page is now a server component that applies `gateAdminPage` with that row
and renders `ReconciliationQueueClient` (the former page body). A row in the
table must belong to a server-gated page (`admin-layout-guard`), and the server
gate also refuses a custom role that withholds the key before anything renders.

**A custom role cannot open the queue to a READER, EDITOR or AI_ADMIN member.**
The edge reads the MEMBERSHIP role, never a custom role's keys, so a custom role
on one of those memberships that grants `identity_reconciliation.view` is still
refused the queue API at the edge, and the page row refuses the same membership
roles. Such a role reaches the queue only on an ADMIN membership.

## Files

| File | Role |
| --- | --- |
| `src/lib/permissions.ts` | `identity_reconciliation.view` off for EDITOR and READER (and so AI_ADMIN) |
| `src/lib/auth/guard.ts` | `RECONCILIATION_VIEW_READ_PATHS`, `RECONCILIATION_VIEW_EDGE_ROLES` (`AUDITOR`), `isReconciliationViewReadPath`, one branch in `checkAdminAccess` |
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
- **The edge role set is spelled out**, because `guard.ts` runs at the edge and
  stays free of the permission tables; `tests/unit/reconciliation-view-key-edge.test.ts`
  holds it equal to the roles below ADMIN that `getPermissionsForRole` gives the key.
- **Removing the default from three roles is a narrowing.** Before this change
  the only consumers of the view key were the queue read and its usecases, all
  under `/admin`, which the edge kept from EDITOR, READER and AI_ADMIN sessions.
  What it does take away: an AGENT-BOUND API key (which passes the edge and is
  narrowed to its human principal, the key's creator) whose creator is now an
  EDITOR, READER or AI_ADMIN member can no longer read the queue over REST —
  minting a key needs `admin.manage`, so only a creator demoted since; and a
  custom role based on
  EDITOR or READER whose stored blob does not name the key inherits `false`,
  which matters only on an ADMIN membership.
- **What the widening exposes.** The queue response carries candidate employees'
  names and work emails (`readQueuePeople`, #4871), which `personnel.view`
  (OWNER/ADMIN only since 2026-10-29) otherwise withholds. Limiting the key to
  AUDITOR is what keeps that from every member.
- **Legacy connections only.** The new read 404s any other provider, so the
  view key does not become a way to read the names of a tenant's other
  integrations. The admin `executions/latest` route is unchanged
  (`admin.manage`) and still serves the connection's runs card.
