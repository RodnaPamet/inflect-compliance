# 2026-11-18 — Training list: server paging and server filters

**Commit:** issue #5764 item 6 (owner decision: add server paging)

## Design

The Training admin page used to read the first 500 assignments
(`TRAINING_LIST_CAP`) and filter them in the browser. Assignment 501 onwards
could not be reached, and the truncation banner told people that refining the
filters would show the rest, which it could not.

```
URL ?q=&status=  ──>  page.tsx (RSC)  ──>  listTrainingAssignments(ctx, {q, status})
   ^                                         first page + nextCursor + total
   |                                              |
filter bar (router.replace)          TrainingClient: useCursorPagination
                                       resetKey = the filters the server applied
                                       "Load more" ──> GET /training?cursor=&limit=&q=&status=
```

- `listTrainingAssignments` pages by the `docs/pagination.md` keyset
  (`createdAt desc, id desc`, `take: limit + 1`, `computePageInfo`), and counts
  the filters' matches in the same tenant transaction.
- The search (employee name, work email, course name, case-insensitive) and the
  status filter run in SQL. OVERDUE is the SQL form of
  `effectiveTrainingStatus`: a stored OVERDUE, or an open assignment past its
  due date; ASSIGNED and IN_PROGRESS exclude past-due rows.
- The page renders the first page for the URL's filters. The filter bar already
  writes `q` and `status` to the URL, so a filter change re-renders the server
  page. `useCursorPagination` gained an optional `resetKey`: when the applied
  filters change, the accumulator restarts from the new first page and drops a
  page still in flight for the old filters.
- New index `TrainingAssignment(tenantId, createdAt)` for the paged sort.

## Files

| File | Role |
| --- | --- |
| `src/lib/training-list.ts` | Page size, filter normalisation, filter key and query (client-safe) |
| `src/app-layer/usecases/training.ts` | Paged, filtered read; `trainingStatusWhere` |
| `src/app/api/t/[tenantSlug]/training/route.ts` | `cursor` / `limit` / `q` / `status`; paged and legacy response shapes |
| `src/app/t/[tenantSlug]/(app)/admin/training/*` | Server first page; client "Load more", true count, banner removed |
| `packages/ui/src/components/ui/hooks/use-cursor-pagination.ts` | Optional `resetKey` |
| `prisma/schema/personnel.prisma` + migration `20261118120000_…` | `@@index([tenantId, createdAt])` |
| `docs/user/guide/admin/training.md` | Help guide |

## Decisions

- **Order changed from "by stored status, then assigned date" to newest
  first.** A keyset cursor over a stored-status sort would need a three-column
  cursor and would still not group by the status people see (an open assignment
  past due reads Overdue). The status filter does the grouping instead.
- **Two response shapes, as `docs/pagination.md` prescribes.** With `cursor` or
  `limit`, `{ rows, nextCursor, total }` (the shape `useCursorPagination`
  reads). Without either, the older `{ assignments, truncated }` keys holding
  the first page, plus `nextCursor` and `total`, so an existing reader keeps its
  keys and can page on.
- **"Load more", not numbered pages.** A keyset cursor cannot jump to page N,
  and `useCursorPagination` is the repository's server-cursor accumulator.
- **The next page uses the filters the server applied, not the filter bar's
  live state.** The cursor belongs to that query; mixing them would page one
  query with another's cursor.
- **A malformed cursor or limit reads as the first page / the default**, as on
  the quarantine list, rather than a 400.
