# 2026-11-24 — chart legends and marks on a phone (#5877)

## Design

On the dashboard at 390 and 360 the mobile harness counted 23 tap targets
under 24px, every one of them a chart: four 8px radar vertices, four radar
axis labels (one 11px line each, focusable for hover), and fourteen to
fifteen donut legend rows (16px lines). The donut arcs themselves measured
at 24px or more with the seed's data.

The rule is now written down in `docs/charts.md` ("Touch"): nothing a phone
user needs depends on hitting a mark.

- **Drill-downs are a list.** The dashboard's donuts already had one, the
  legend beside each donut, whose rows are the slices' links. On a coarse
  pointer a row is 44px (`pointer-coarse:min-h-11`) and the gaps between
  rows go, so the legend reads as one list. The arcs stay clickable.
- **Marks that only highlight take no taps on touch.** `RadarChart` wraps its
  marks in a `<g>` with `pointer-coarse:pointer-events-none`. A vertex or a
  label does nothing but highlight its spoke, which a finger hides anyway. A
  tap now lands on the chart itself. The dashboard shows the same values in
  the posture ladder beside the radar.
- **A large-screen diagram switches to a list below `md`.** `SankeyChart` now
  renders `SankeyFlowList` below `md` and the diagram from `md` up. #5908 had
  put this switch on the controls flow page. Moving it into the chart means
  no page can show the diagram on a phone without the list.

The posture ladder's rows went from 11px to `text-xs` (12px).

Measured on the dashboard after the change, at both configurations: zero
targets under 24px and zero text under 12px. `/tenants` sends the seeded
admin, who has one workspace, straight to that workspace's dashboard, so it
measures the same.

## Files

| File | Role |
|---|---|
| `src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx` | `DonutLegendRow` is a 44px row on touch, and is exported for its test. The three legend lists drop their gap on touch. |
| `src/app/t/[tenantSlug]/(app)/dashboard/PostureLadder.tsx` | Rows at `text-xs`. |
| `src/components/ui/charts/radar-chart.tsx` | The marks group is inert on a coarse pointer. |
| `src/components/ui/SankeyChart.tsx` | Holds the phone list (`SankeyFlowList`, the page's former `SankeyFlowSummary`, now fed the chart's own dataset), and renders it below `md` and the diagram from `md` up. |
| `src/app/t/[tenantSlug]/(app)/controls/sankey/ControlsSankeyClient.tsx` | Mounts the chart alone. |
| `messages/{en,bg}.json` | The list's strings move from `controls.sankey.phone` to `common.ui.sankeyPhone`. |
| `tests/e2e/mobile-ratchet.ts` | `tapUnder24` baseline 1 → 0: no fixed route has a target under 24px. |
| `docs/charts.md` | The "Touch" rule. |

## Decisions

- **Inert, not enlarged, for the radar.** A transparent 44px hit circle per
  vertex would overlap its neighbours wherever the polygon is small (low
  levels sit close to the centre), and a label's hit box would
  run past the SVG's edge. Enlarging a target that only highlights buys
  nothing a finger can see. Keyboard focus, hover and the accessible names
  are untouched, because pointer events do not reach any of them.
- **The radar change is in the primitive, for every radar.** The NIS2 gap
  and org maturity radars get the same touch behaviour. Their marks also
  only highlight, so on a phone they lose nothing but that highlight.
- **Donut arcs are left clickable.** The seed's slices measure 24px or more,
  and the legend beside each donut already offers every slice's link.
  Making the arcs inert on touch would need `pointer-events` overridden on
  three nested SVG layers, because the hit path sets `pointer-events="all"`
  itself. That rework is not worth it while the list carries the action. A
  very thin slice can still be small. It is a convenience, and the list
  covers it.
- **The Sankey list takes the dataset, not the graph.** Before, the page
  projected the graph a second time, without the chart's search. Now the
  chart passes the dataset it draws, so the list and the diagram cannot
  disagree, even with a search applied.
- **The Sankey's empty and no-link states have no list.** They are a
  sentence in a card, which reads at any width, so the chart shows them at
  every width. Before, the page showed the notice and the sentence again on a
  phone.
- **No page-level `next/dynamic`.** Nothing here is a heavy import. The
  dashboard changes are class names on code the route already ships. The
  Sankey list moved from the page into the chart, and only the controls flow
  page imports the chart.
- **The list lives in `SankeyChart.tsx`, not a file of its own.** It reads
  the traceability types, so as its own file under `src/components/ui/` it
  would be a new domain-coupled shared-UI file, and
  `tests/guards/shared-ui-coupling-ratchet.test.ts` holds that count. The
  chart is already classified COUPLED ("coupling IS the file"), so the list
  adds no coupled file there.
