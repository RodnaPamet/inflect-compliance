# 2026-10-29 — Read accounts and match them to people, from the connection page

**Commit:** `feat(legacy-access): read accounts and match them to people from the connection page`

## Design

A legacy application's connection page (`admin/integrations/[connectionId]`)
gains an "Accounts and matching" card beside the column-mapping card:

```
LegacyAccessRunsCard
  ├─ Latest read     GET  admin/legacy-access/snapshot?connectionId=   (new, admin.manage)
  ├─ Read accounts   POST admin/legacy-access/pull       { connectionId }  → 202 { jobId }
  ├─ Match to people POST admin/legacy-access/reconcile  { snapshotId }    → 202 { jobId }
  └─ Last read / Last match   ← the page's own executions rows (Check runs)
```

Both actions are BullMQ jobs, so the card says the run started, names the job,
and says where the result appears. The result is the run's
`IntegrationExecution` row: the card reads the newest `legacy-mcp.pull` and
`legacy-mcp.reconcile` row from the rows the page already loads for Check runs,
and shows the status with its NAMED reason (a refusal's code from
`errorMessage`, with its sentence when the build knows the code; an ERROR's
message as written). Refresh reloads the rows and the standing. Nothing polls.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/legacy-access-standing.ts` | The standing read: latest snapshot, its counts, the latest run over it |
| `src/app/api/t/[tenantSlug]/admin/legacy-access/snapshot/route.ts` | `GET`, `admin.manage` |
| `src/lib/legacy-access/latest-snapshot.ts` | `LATEST_SNAPSHOT_ORDER` / `LATEST_RESOLUTION_ORDER`, shared with campaign creation |
| `src/app-layer/usecases/access-review-legacy.ts` | Uses the shared order constants (no behaviour change) |
| `…/[connectionId]/LegacyAccessRunsCard.tsx` | The card |
| `…/[connectionId]/useIsLegacyConnection.ts` | Provider detection, extracted from the mapping card |

## Decisions

- **One read API was added, because nothing else returns a snapshot id.** The
  reconcile route takes only `{ snapshotId }`; the pull and reconcile routes
  answer with a job id; neither execution row records the snapshot or its
  counts. The read returns statistics only (status, dates, row counts, refusal
  reason and detail, coverage, counts per outcome), never an account.
- **The page and campaign creation pick the same snapshot.** Both order by
  `LATEST_SNAPSHOT_ORDER`, so what the card calls matched is what a campaign
  finds matched. `completedAt` DESC sorts a NULL first, so a read still in
  progress is the latest for both readers; the integration test pins that
  agreement rather than either reader's choice alone.
- **Counts come from rows.** `rowCount` is the snapshot's own column; matching
  counts are a `groupBy` over the latest run's resolution rows. The executions
  were deliberately not given a `resultJson` copy of either: a copy is derived
  data beside its source, and older executions would carry none.
- **The gate hides.** The routes, the standing read and the connection list
  that decides whether the card applies all take `admin.manage`, so a viewer
  without it gets no card and no request (each refused request would write an
  `AUTHZ_DENIED` row for a visit), as the page's owner card is gated at its
  mount.
- **"Match to people" is disabled, with the reason, when it is certain to be
  refused**: no read, a read that is not COMPLETE, or one with no accounts. The
  server refuses the same cases on its own; the roster-freshness refusal stays
  server-only and is shown as the run's result.
- **Every refusal code is keyed exhaustively.** `Record<LegacyAccessRefusalReason, true>`
  and `Record<ReconcileRefusal, true>` make a new code a compile error until it
  has a sentence; the rendered test checks both catalogues carry each one. A
  code the build does not know is still shown by name.
