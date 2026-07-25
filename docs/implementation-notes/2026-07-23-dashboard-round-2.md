# 2026-07-23 — Executive dashboard round-2 (layout fixes + swappable KPI)

## Design

Four changes to the tenant executive dashboard
(`src/app/t/[tenantSlug]/(app)/dashboard/`):

1. **Even KPI-card height.** The six-tile KPI grid rendered two short
   tiles (Open tasks, Policies) because they carry no `trend` sparkline
   (the `h-8` trailing slot) while their four siblings do. Fix is
   purely layout: `h-full` on the `KpiTile` wrapper (already
   grid-stretched) + `h-full` on each `<KpiCard>` so every tile fills
   the row height.

2. **Evidence-expiry card fills its section.** `<ExpiryCalendar>` sized
   to content (`max-h-[280px]`) and left a gap under its taller row
   sibling (the risk heatmap). New opt-in `fill` prop makes the card a
   flex column whose item list is `flex-1 min-h-0` (grows + scrolls),
   wired on the dashboard with a `h-full` focus wrapper.

3. **Segregated compliance-trend tiles.** The four `<TrendCard>`s sat in
   border-less focus wrappers and blended into one strip. Added
   `className` passthrough to `ChartFocusWrapper` and a shared
   `trendTileClass` (subtle border + inset) on the four tiles.

4. **Swappable custom-KPI card (feature).** A new `<CustomKpiPanel>`
   below the KPI grid: a picker chooses a KPI from a catalog OUTSIDE the
   fixed executive payload — **assets / audits / control tests** — and
   the selection swaps both the tile and the pie it renders. Data is
   fetched on demand from a new endpoint; the selection persists in
   `localStorage`. Trends are deferred ("pie now, trends later" — the
   daily snapshot series doesn't yet carry these entities), so the third
   cell shows a collecting-data notice.

```
picker ─▶ localStorage(dashboard.customKpi)
             │
             ▼
   useTenantSWR(/dashboard/kpi/{key})  ◀── GET route ── getDashboardKpi(ctx,key)
             │                                              │ assertCanRead + tenant-scope
             ▼                                              ▼
   KpiCard tile │ DonutChart pie │ trend-coming notice   DashboardRepository.get{Asset,Audit,Test}Summary
```

## Files

| File | Role |
| --- | --- |
| `dashboard/DashboardClient.tsx` | Fixes 1–3; new `CustomKpiPanel` + catalog meta |
| `components/ui/ExpiryCalendar.tsx` | New `fill` prop (flex-column, growing list) |
| `repositories/DashboardRepository.ts` | New `AuditSummary`/`TestSummary` + `getAuditSummary`/`getTestSummary` (reuses `getAssetSummary`) |
| `usecases/dashboard.ts` | `getDashboardKpi` + DTO/key types + `SWAPPABLE_KPI_KEYS` |
| `api/t/[tenantSlug]/dashboard/kpi/[kpiKey]/route.ts` | On-demand GET, tenant + read scoped |
| `lib/swr-keys.ts` | `CACHE_KEYS.dashboard.kpi(key)` |
| `messages/{en,bg}.json` | `dashboard.customKpi.*` |

## Decisions

- **On-demand endpoint, not payload extension.** Adding assets/audits/
  tests to the shared `ExecutiveDashboardPayload` would break its
  fixtures/cache and load three summaries every render for data most
  users never open. A dedicated `/dashboard/kpi/{key}` route keeps the
  default dashboard untouched and loads a KPI only when picked.
- **Self-contained panel, outside the fixed focus graph.** The existing
  6-KPI chart-focus context uses a closed `DashboardKpiKey` union. The
  custom panel owns its own tile+pie+trend locally rather than widening
  that union, so the established focus wiring is undisturbed.
- **Segment labels/colours are server data.** Mirrors the existing donut
  pattern (hardcoded English segment labels in the client); visible
  chrome (title, picker, notices) goes through `next-intl`.
- **`getAssetSummary` already existed** (snapshot job) and was reused;
  only audits + tests needed new `groupBy` aggregations, both over
  existing indexes (`AuditCycle (tenantId, deletedAt)`,
  `ControlTestRun (tenantId, result)`).
