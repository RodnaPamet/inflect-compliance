# 2026-10-29 — Audit log: Auditor access, paging and readable entries

**Commits:** `8e7e181c3`, `62617818b`, `5c23f5485`, `aa88eddfe` (#4468).

## Design

Owner decision 2026-10-29: Auditors may open the Audit log page, read-only.
#4489 had already made the page's server gate admit `canAudit` (OWNER, ADMIN,
AUDITOR). Three layers sat between an Auditor and the page, and each needed a
different answer:

```
edge (src/middleware.ts)    refuses a non-admin role on /t/<slug>/admin/**;
                            for a PAGE it lets the request on to the App Router
server gate (gateAdminPage) ADMIN_PAGE_REQUIREMENTS['/admin/audit-log'] = canAudit
client layout (admin/layout.tsx)  showed only to admin.view → "Access denied"
```

1. **Edge.** The refused-page branch returned `NextResponse.next()` and so
   skipped the MFA gates that follow it. Harmless while every page refused the
   same roles the edge did; not once a page's server gate admits a role the
   edge refuses. The branch now falls through, so a refused page request still
   passes MFA (both the primary-workspace and per-workspace checks) before it
   reaches the page. Refused API requests are unchanged.
2. **Client layout.** It now shows a page when the caller holds `admin.view`
   OR the page's `ADMIN_PAGE_REQUIREMENTS` row admits them, found from the
   browser path by `adminPageRouteForPath`. Every row except the audit log's
   includes `admin.view`, so the second half adds nobody elsewhere; a unit test
   pins the audit log as the only row without it.
3. **The page itself.** Cursor paging on `(createdAt, id)` through the shared
   `@/lib/pagination` helpers, reading one row past the page; readable action
   and entity labels; the Details column without `logEvent`'s request
   reference, falling back to `detailsJson.summary`.

## Files

| File | Role |
| --- | --- |
| `src/middleware.ts` | refused admin page request continues through the MFA gates |
| `admin/_lib/admin-page-requirements.ts` | `adminPageRouteForPath` — browser path → table row |
| `admin/layout.tsx` | shows a page whose row admits the caller, else the `admin.view` floor |
| `src/app-layer/repositories/AuditLogRepository.ts` | `listPage` — one cursor page, limit + 1 |
| `src/app-layer/usecases/auditLog.ts` | `listAuditLogPage`, same `assertCanAudit` gate |
| `admin/audit-log/page.tsx` | `?cursor=`, row projection, Admin crumb only with `admin.view` |
| `admin/audit-log/AuditLogClient.tsx` | readable columns, paging links, no row selection |
| `src/lib/audit/audit-log-display.ts` | pure display helpers |

## Decisions

- **Fix the edge generally, not with an Auditor allowlist entry.** Adding the
  page to the edge's AUDITOR paths would have closed the built-in case only. A
  custom role granting `admin.view` on a membership whose built-in role is not
  ADMIN or OWNER is refused by the edge (which reads the built-in role) and
  admitted by every `admin.view` page's server gate, so it took the same path.
  Falling through closes both and adds no path to any allowlist.
- **The layout reads the server gate's table** rather than carrying its own
  audit-log exception, so the screen and the payload cannot disagree about a
  page in the table.
- **Paging is a server read with `?cursor=` links**, not the org page's
  client "load more" through the API. The page needs no API call, so the edge's
  API rules for Auditors do not come into it, and the tenant API's response
  shape (a bare array) is unchanged for its existing callers.
- **No `TruncationBanner`.** Its copy tells the reader to refine filters, and
  this page has none; an "Older entries" link is the honest affordance.
- **Labels are readable, not translated.** There are hundreds of action codes;
  translating them is out of proportion. Entities the dashboard feed already
  translates use that noun; everything else is the code as sentence-case words.
- **Details prefer the writer's sentence over `detailsJson.summary`.** Where
  both exist the sentence is the more specific (it names the record).
