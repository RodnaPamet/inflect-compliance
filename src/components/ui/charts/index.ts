/**
 * Epic 59 — chart platform barrel, app-side façade.
 *
 * 21 neutral chart primitives moved into `@inflect/ui` (#3046). This file
 * re-exports them, so every existing `@/components/ui/charts` import keeps
 * working unchanged, and declares the seven that stayed.
 *
 * WHY EACH ONE STAYED — the compiler decided this, not a preference:
 *
 *   ChartFrame      needs `empty-state` / `error-state` / `skeleton`, which
 *                   need `button` / `typography` / `card`. A later batch.
 *   LineChart,      each wraps ChartFrame.
 *   RadarChart,
 *   GanttChart,
 *   FunnelChart
 *   LossExceedanceCurve,  both import `@/lib/risk-coherence` — this repo's
 *   AleHistogram          risk model, which a vendored package must not carry.
 *
 * This façade is not meant to be permanent. As consumers are rewritten to
 * import `@inflect/ui/components/ui/charts` directly they should stop coming
 * through here. What it must never become is a second place where chart API is
 * DECLARED — it only re-exports.
 */

export * from '@inflect/ui/components/ui/charts';

export * from './funnel-chart';

// ─── Roadmap-16 — ChartFrame wrapper ────────────────────────────────
//
// Responsive container + state-driven branch rendering. Every R16
// chart consumer mounts inside `<ChartFrame>` so loading / empty /
// error states share the same vocabulary across charts.

export { ChartFrame } from './chart-frame';

// ─── Roadmap-16 — LineChart primitive ───────────────────────────────
//
// Smooth single-series line + area-under-line gradient + on-mount
// path draw. Phase 3 of R16.

export { LineChart } from './line-chart';

// ─── Roadmap-16 — RadarChart primitive ──────────────────────────────
//
// Multi-axis radar chart with gradient polygon fill. Phase 4 of R16.

export { RadarChart } from './radar-chart';

export type { RadarAxisDatum } from './radar-chart';

// ─── Roadmap-16 — GanttChart primitive ──────────────────────────────
//
// Horizontal Gantt with gradient bars + dependency arrows. Phase 5.

export { GanttChart } from './gantt-chart';

export type { GanttRow } from './gantt-chart';

// ─── B10 — Loss Exceedance Curve primitive ──────────────────────────
//
// Quantitative-risk visualisation: x = loss threshold, y = fraction
// of risks with ALE ≥ threshold. Pure SVG via visx scale + LinePath
// + Area + axis chrome. Token-themed via --chart-series-1; no
// hover / no animation — single-purpose, fast, accessible.

export { LossExceedanceCurve } from './loss-exceedance-curve';

export type {
    LossExceedancePoint as LossExceedanceChartPoint,
    LossExceedanceCurveProps,
    LossReferenceLine,
} from './loss-exceedance-curve';

// RQ3-5 — "from heatmaps to histograms": the log-x ALE histogram,
// stacked by tenant matrix band, with the per-risk appetite line.
export { AleHistogram, bucketByDecade } from './ale-histogram';

export type { AleHistogramDatum, AleHistogramProps } from './ale-histogram';
