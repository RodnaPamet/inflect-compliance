# Lickable Charts — R16 Decision Tree

R16 (Lickable Charts) shipped 12 PRs across two phases:
**foundations** (tokens · gradients · frame · motion hooks) and
**chart primitives** (donut · line · radar · gantt) — each chart got
a visual rebuild PR plus a hover PR. This doc is the decision tree
for picking the right primitive and the right gradient layer.

## What's in `@/components/ui/charts`

After R16 the barrel exposes:

### Token + gradient primitives
- `<ChartLinearGradient>` — 2-stop linear gradient. Bars, area-under-line, gantt rows.
- `<ChartRadialGradient>` — radial gradient. Donut segments, radar polygon fill.
- `<ChartFlowGradient>` — 3-stop cyclic gradient + `gradientTransform`-animatable. Used by `useChartFlow` for hover gradient-pan.
- `chartGradientId(chartId, series, variant)` — canonical id helper.
- `type ChartSeriesIndex = 1 | 2 | 3 | 4 | 5 | 6` — palette is locked at 6.

### Frame + motion
- `<ChartFrame state={state}>` — responsive container + state-driven loading/empty/error/ready branches. Every R16 chart consumer mounts inside this.
- `useChartHoverPop({ hoveredKey })` — hover-pop transforms for donut segments / bars / line focus points / radar vertices.
- `useChartFlow({ active, distance, direction })` — animates `gradientTransform` translate on a `<ChartFlowGradient>` ref.

### Chart primitives
- `<DonutChart>` — proportional distribution (visx Pie + radial gradient + flow on hover). Existing in `@/components/ui/DonutChart`.
- `<LineChart>` — smooth single-series trend (curveCatmullRom + area-fade + crosshair on hover).
- `<RadarChart>` — multi-axis profile (polygon mesh + radial gradient + vertex pop on hover).
- `<GanttChart>` — horizontal timeline (gradient bars + bezier dependency arrows + chain highlight on hover).

## When to use which

```
                     ┌────────────────────────────────────────────┐
                     │              What are you visualising?     │
                     └────────────────────────────────────────────┘
                                          │
        ┌─────────────────────────────────┼──────────────────────────────────┐
        │                                 │                                  │
        ▼                                 ▼                                  ▼
 Proportions of a            Trend over time                  Multi-dimensional
 single quantity              (single series)                  profile
        │                                 │                                  │
        ▼                                 ▼                                  ▼
   <DonutChart>                    <LineChart>                       <RadarChart>


                     ┌────────────────────────────────────────────┐
                     │      Schedule with dependencies?           │
                     └────────────────────────────────────────────┘
                                          │
                                          ▼
                                   <GanttChart>


                     ┌────────────────────────────────────────────┐
                     │      None of the above?                    │
                     └────────────────────────────────────────────┘
                                          │
                                          ▼
              fall back to existing chart-platform primitives
              (TimeSeriesChart, FunnelChart, Areas, Bars, ...)
```

## Picking a series index

`ChartSeriesIndex = 1..6`. The numeric index resolves to themed
hex stops at the token layer.

- **Series 1** — primary brand. The "headline" colour.
- **Series 2** — cyan METRO / navy light. The "cool" tone.
- **Series 3** — violet METRO / teal light. Secondary cool.
- **Series 4** — coral / rose. Warm-pink bridge.
- **Series 5** — emerald / forest. "Growth" / positive.
- **Series 6** — amber-warm. "Alert" / due-soon.

Adjacent series end/start stops are tuned for perceptually
neighbouring tones — adjacent shapes (stacked bars, donut
segments) blend visually at the boundary rather than jumping
between hues.

## The hover vocabulary (memorise this once, apply everywhere)

| Surface | Engage state | Tempo |
|---|---|---|
| Donut segment | translate 4 px radially outward + flow gradient pan | 200 ms ease-out |
| Bar / line focus | translate 2 px upward | 200 ms ease-out |
| Line focus point | scale 1.05× + tooltip + crosshair | 200 ms ease-out |
| Radar vertex | scale 1.05× + axis line brightens + label emphasis | 200 ms ease-out |
| Gantt bar | translateY -2 + dependency chain highlight | 200 ms ease-out |

Subtle by design. The user-confirmed "subtle" pop intensity
(R16-PR1) sits at small displacement values that read as "this
is the one you're pointing at" without making the chart feel
jumpy.

## When to NOT reach for R16

- **Static print views** — print stylesheets can render the
  chart-platform shape primitives directly without R16 motion.
- **Tiny KPI sparklines** — the existing `<MiniAreaChart>` (Epic 59)
  is built for compact cells and renders without a frame.
- **Pre-existing TimeSeriesChart consumers** — fine to leave as
  is. Migrate when re-touching the file for other reasons.

## Adding a 13th series

Don't. Six is locked at the token layer + `ChartSeriesIndex`
type union. Adding a 7th requires:
1. New tokens on both themes
2. `ChartSeriesIndex` widened in `chart-gradient.tsx`
3. Adjacent-tonal pairing re-validated (the 7th series'
   start-stop must sit in a perceptual neighbourhood of
   series 6's end-stop AND series 1's start-stop — closing
   the loop)
4. Ratchet at `tests/guards/r16-chart-tokens.test.ts` updated

It's not impossible — it's a conscious vocabulary change. Bring
the proposal explicitly.

## What landed after R16

The deferred-until-R16-PR6-decision items (we picked "decide
later") have since shipped across two later waves:

- R17 took the chart family in a different direction first —
  ambient glow, breath animation, hero sparklines, clickable KPIs,
  and filter-aware donut/charts (see the `r17-*` ratchets).
- R21 (below) closed out the originally-deferred chart rebuilds:
  Sankey rebuild on R16 primitives, heatmap rebuild (RiskHeatmap +
  CalendarHeatmap on `useHeatScale` + `<ChartLegend>`), and funnel
  polish.
- A shared tooltip primitive (`ChartTooltipContainer`) is in
  `src/components/ui/charts/interaction.tsx`, consumed by the funnel
  and time-series charts.

The remaining deferred items are tracked under "Future direction"
at the end of this doc.

## Quick API examples

### Donut
```tsx
const segments = [
  { label: 'Open', value: 10, seriesIndex: 6 },
  { label: 'Mitigating', value: 5, seriesIndex: 5 },
  { label: 'Closed', value: 3, seriesIndex: 3 },
];
<DonutChart segments={segments} centerLabel="18" centerSub="Risks" />
```

### Line
```tsx
const state = chartReady<TimeSeriesPoint[]>([
  { date: new Date('2026-04-01'), value: 70 },
  { date: new Date('2026-04-02'), value: 72 },
  // …
]);
<LineChart state={state} seriesIndex={1} ariaLabel="Readiness — last 30 days" />
```

### Radar
```tsx
const state = chartReady<RadarAxisDatum[]>([
  { key: 'access', label: 'Access control', value: 85 },
  { key: 'crypto', label: 'Cryptography', value: 92 },
  { key: 'incident', label: 'Incident response', value: 78 },
  // …
]);
<RadarChart state={state} seriesIndex={2} maxValue={100} />
```

### Gantt
```tsx
const state = chartReady<GanttRow[]>([
  {
    key: 'plan',
    label: 'Plan',
    start: new Date('2026-05-01'),
    end: new Date('2026-05-10'),
    seriesIndex: 1,
  },
  {
    key: 'execute',
    label: 'Execute',
    start: new Date('2026-05-10'),
    end: new Date('2026-05-25'),
    seriesIndex: 2,
    dependencies: ['plan'],
  },
  // …
]);
<GanttChart state={state} todayLine ariaLabel="Audit cycles timeline" />
```

<!-- docs-accuracy-allow: "Roadmap-21" is the shipped wave codename, required verbatim by tests/guards/r21-prf-bar3d-capstone.test.ts -->
## Roadmap-21 — Sculpted Charts (3D)

R21 extends the chart family in three directions:

- **Sankey rebuild** — Sankey speaks the same `--chart-series-*`
  vocabulary as the rest of the family via `<ChartLinearGradient>`.
  Click-isolate + inline weight annotations.
- **Heatmap rebuild** — `RiskHeatmap` + `CalendarHeatmap` move onto
  a new `useHeatScale` hook + `<ChartLegend variant="gradient">`
  primitive. Continuous OKLAB interpolation replaces bucket-step
  palettes; legend paints from the same tokens the cells consume.
- **Funnel polish** — `FunnelChart` swaps `curveBasis` →
  `curveCatmullRom`, accepts optional `seriesIndex` for gradient
  fills (backward-compat with `colorClassName`), adds between-stage
  conversion-rate annotations + hover-isolate sibling fade + the
  shared `ChartTooltipContainer` tooltip surface.

### 3D charts (`<Chart3D>` + `<BarField3D>`)

R21-PR-E added `@react-three/fiber` + `drei` + `three` (~180KB gz,
code-split). The bundle only loads on routes that mount a 3D chart
— `dynamicChart3D()` wraps `<Chart3D>` in `next/dynamic({ ssr:
false })` so server-rendered HTML carries a clean placeholder until
client hydrate.

`<Chart3D>` carries the conventions every 3D chart in IC shares:

- Required `ariaLabel` (WebGL canvas is opaque to screen readers).
- Lights + camera defaults (ambient + key directional, isometric-
  ish camera at `[6, 4, 6]`).
- Constrained OrbitControls — no pan, polar-angle clamp prevents
  top-down or below-floor rotation.
- Idle auto-rotate at 0.5°/s that STOPS the moment the cursor
  enters the canvas.
- `prefers-reduced-motion` → `FallbackComponent` (2D static
  representation of the same data). Charts SHOULD supply this for
  accessibility + low-end-device support.
- `tokenColor(seriesIndex, 'start'|'end')` resolves a chart-series
  CSS var to the hex string Three.js materials need.

```tsx
import { dynamicChart3D, BarField3D } from '@/components/ui/charts';

// Page-level (SSR-safe import):
const Chart3D = dynamicChart3D();

<BarField3D
  ariaLabel="Risk count by severity × quarter"
  data={[
    { x: 'Q1', z: 'Low', y: 12 },
    { x: 'Q1', z: 'High', y: 4 },
    { x: 'Q2', z: 'Low', y: 18 },
    // …
  ]}
  seriesIndex={4}
  FallbackComponent={() => <RiskHeatmap cells={…} />}
/>
```

The first 3D chart is **`<BarField3D>`** — a cross-tab of two
discrete dimensions (time × category) as a grid of bars with
value-encoded heights. Bars carry the chart-series gradient (base
= `start`, tip = `end`); the 2D fallback is naturally a heatmap
since the data shape is identical.

## Future direction

Deferred chart-family items not yet built:

- **Chart-pattern library** — crosshatch for disabled, dots for
  projected, etc., for fills that need to convey state beyond hue.
- **Multi-axis stacked variants** of the R16 chart primitives.
- **GraphExplorer node refresh** onto the shared chart vocabulary.
