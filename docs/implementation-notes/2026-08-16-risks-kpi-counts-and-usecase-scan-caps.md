# 2026-08-16 — Risks KPI counts, and the caps Layer D2 could not see

**Commit:** `<pending>` fix(risks): KPI cards count what their click returns

Two findings from the same sweep over Controls / Risks / Admin. Independent
defects, bundled because both are "a list surface reads more than it should".

## Design

### 1. Risks was the last surface counting KPI cards client-side

Policies (#1905), Vendors (#1917), Tests (#1918) and Controls each serve KPI
card counts as DB aggregates. `risks/route.ts` had no `kpiCounts` at all;
`RisksClient` computed them over `risks`, which is the **server-filtered** set
(`risksKey` puts `fetchParams` in the SWR key) and backfill-capped at 5,000 on
top.

That reproduced both halves of the defect the peers were fixed for:

- `total` displayed the current **filtered** length while its click calls
  `clearAll()` — so with any filter set, the number and the click disagreed.
- `open` counted inside a set that already had `status` applied while its click
  **replaces** that dimension — so under any status filter it read 0,
  permanently.

Plus a third, independent of windowing: the card counted `OPEN + MITIGATING`
but applied `OPEN` alone, so clicking it returned fewer risks than the number
promised. Fixed the way the identical Policies `approved` defect was — **widen
the filter, don't narrow the count**. The number a user is reading is the
commitment; `MITIGATING` is "open" in any sense a user means it.

`avgScore` is the one card that is *not* clickable, so it legitimately
describes the current view — but it is now a `_avg` aggregate over the same
filters rather than a mean of whatever fitted on the page, so it stays correct
above the cap.

The "Stale" card was already correct and is untouched: it comes from a separate
`/risks/staleness` request, so it was never windowed by the list query.

### 2. Three unbounded whole-tenant reads, all invisible to Layer D2

The Layer-D2 budget in `query-shape-guardrails.test.ts` bounds unbounded
`findMany` calls, but it scans `src/app-layer/repositories`. All three of these
live in `src/app-layer/usecases`, so the budget could never have flagged them —
this is a blind spot in the guard, not a lapse against it.

| read | note |
|---|---|
| `listRisksWithDeleted` | its direct Controls twin `listControlsWithDeleted` **was** capped at `FULL_SCAN_CAP`. Worse than the twin: no `select`, so it returns full rows, and `Risk` carries encrypted columns — the Epic-B middleware decrypts `treatmentNotes` on every row returned. |
| `listTenantMembers` | backs `/admin/members`. |
| `listAssignableUsers` | highest traffic of the three — it feeds every `UserCombobox` in the product. |

All three now carry a named cap. The recycle-bin pair uses the same
`FULL_SCAN_CAP = 5000` constant and reasoning as its twin; the two membership
scans share a new `MEMBERSHIP_SCAN_CAP`.

## Files

| file | role |
|---|---|
| `src/app-layer/repositories/RiskRepository.ts` | `kpiCounts` — tenant count for `total`, status-dropped `groupBy` for `open`, `_avg` for `avgScore` |
| `src/app-layer/usecases/risk.ts` | `listRiskKpiCounts` seam; `FULL_SCAN_CAP` on the recycle-bin read |
| `src/app-layer/usecases/tenant-admin.ts` | `MEMBERSHIP_SCAN_CAP` on both membership scans |
| `src/app/api/t/[tenantSlug]/risks/route.ts` | serves `kpiCounts` beside the rows |
| `src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx` | prefers server counts; `open` applies both statuses it counts |
| `tests/unit/repositories/RiskRepository.kpi-counts.test.ts` | behavioural — mock `db` records the WHERE shapes each aggregate receives |
| `tests/guards/risks-kpi-server-counts.test.ts` | the three-layer wiring |
| `tests/unit/usecases/whole-tenant-scans-bounded.test.ts` | per-function cap assertions + D2's documented blind spot |

## Decisions

- **The count test is behavioural, not structural.** A mock `db` records what
  each aggregate is called with, so the assertions fail if the WHERE shapes
  regress even while the method still exists and still returns three numbers.
  The structural guard is scoped to the wiring across the three layers, which
  is the part a mock cannot see.

- **`open` widened rather than narrowed.** Same call as the Policies
  `approved` card. Shrinking the count to match the filter would have made the
  card honest and useless; widening the filter makes it honest and right.

- **Per-function bounding on the cap assertions.** Verified by removing each
  cap independently — including the two that live in the *same file* — and
  confirming each failure lands on its own function. A cap on a neighbour
  cannot satisfy the assertion, which is the failure mode that made an earlier
  whole-file count in this repo vacuous.

- **`whole-tenant-scans-bounded` asserts D2's blind spot on purpose.** If the
  budget ever grows to scan `usecases/`, that test fails and the file should be
  **deleted** rather than left behind as a second source of truth.

- **Used the shared `functionBodyOf`** from `tests/helpers/source-blocks`
  instead of the hand-rolled brace matcher first written here. The shared one
  skips quoted text and comments; a naive matcher terminates early on a brace
  inside either.
