/**
 * Epic 59 — chart platform barrel (shared package).
 *
 * The neutral half of the chart platform: scales, axes, gradients, motion,
 * tooltips, the 3D field and the time-series chart. Every primitive here is
 * free of this repo's domain model, which is what makes the package vendorable
 * by another product (#3046).
 *
 * WHAT IS DELIBERATELY NOT HERE, and it is not an oversight:
 *
 *   ChartFrame, and so LineChart / RadarChart / GanttChart / FunnelChart
 *     ChartFrame renders the empty / error / loading chrome, so it needs
 *     `empty-state`, `error-state` and `skeleton` — flat primitives that in
 *     turn need `button`, `button-variants`, `typography`, `card` and
 *     `card-variants`. That cluster is a batch of its own; pulling it in here
 *     would have made this one the whole of `components/ui`.
 *   LossExceedanceCurve, AleHistogram
 *     Both import `@/lib/risk-coherence` — quantitative-risk domain logic.
 *
 * `src/components/ui/charts/index.ts` re-exports this file and adds those
 * seven, so every existing `@/components/ui/charts` import still resolves.
 */

// ─── Primitives ────────────────────────────────────────────────────────

export * from './areas';

export * from './bars';

export * from './x-axis';

export * from './y-axis';

// ─── Full charts ──────────────────────────────────────────────────────

export * from './time-series-chart';

// ─── Coordination (context + sync across multiple charts) ─────────────

export * from './chart-context';

export * from './tooltip-sync';

// ─── Roadmap-16 — Lickable Chart gradient primitives ─────────────────
//
// SVG `<defs>` gradient primitives wired to the R16-PR1 token
// foundation. Every R16 chart consumer (donut, line, radar, gantt)
// paints fills via `fill="url(#<id>)"` referencing a gradient
// rendered through one of these primitives.

export {
    ChartLinearGradient,
    ChartRadialGradient,
    ChartFlowGradient,
    chartGradientId,
} from './chart-gradient';

export type {
    ChartSeriesIndex,
    ChartGradientDirection,
} from './chart-gradient';

// ─── Roadmap-18 — ChartGloss specular-highlight primitive ───────────
//
// The "light" layer that sits ON TOP of a ChartGradient colour
// layer. A white → transparent ramp consumers paint as an overlay
// shape (same `d`, stacked) to give chart surfaces a glass
// catch-light. See chart-gloss.tsx for the two-layer paint
// contract.

export { ChartGloss, chartGlossId } from './chart-gloss';

export type {
    ChartGlossDirection,
    ChartGlossIntensity,
} from './chart-gloss';

// ─── Roadmap-18 PR-10 — ChartSheenSweep periodic light pan ──────────
//
// The MOVING counterpart of ChartGloss: a narrow white band that
// pans across the surface on a slow loop. Pair `<ChartSheenSweep>`
// with the `useChartSheen` motion hook (see chart-motion exports).

export { ChartSheenSweep, chartSheenId } from './chart-gloss';

export type { ChartSheenDirection } from './chart-gloss';

// ─── Roadmap-16 — chart motion hooks ────────────────────────────────
//
// `useChartHoverPop` — hover-pop transforms for donut segments /
// bars / line focus points. Subtle by design (4px donut, 2px lift,
// 1.05× scale). Motion-reduce snaps to identity.
//
// `useChartFlow` — animate `gradientTransform` translate on a
// `<ChartFlowGradient>` ref so the gradient pans across the segment
// in a continuous loop. The "flowing river" effect.

export {
    useChartHoverPop,
    useChartFlow,
    CHART_HOVER_POP_DISTANCE,
    CHART_HOVER_LIFT,
    CHART_HOVER_POINT_SCALE,
    CHART_FLOW_PERIOD_MS,
    // R18-PR2 — bubbly-settle entrance spring
    useChartSpring,
    CHART_SPRING_DURATION_MS,
    CHART_SPRING_OVERSHOOT,
    // R18-PR10 — periodic sheen-sweep loop
    useChartSheen,
    CHART_SHEEN_PERIOD_MS,
} from './chart-motion';

// ─── Roadmap-21 — Sculpted Charts foundation ────────────────────────
//
// PR-A: shared `useHeatScale` hook + `<ChartLegend>` primitive.
// `useHeatScale` maps a value to a CSS `color-mix(in oklab, ...)`
// interpolated between two chart-series tokens — theme-agnostic,
// continuous, perceptually uniform. `<ChartLegend>` carries two
// variants: discrete series-swatch list (for line/radar/sankey)
// and continuous gradient strip (for heatmaps). The heatmap legend
// shares its `gradientId` with the cell fills so the legend ramp
// and the cells are visually continuous.

export {
    useHeatScale,
    buildHeatColorMix,
    buildStepValues,
    clampIntensity,
} from './use-heat-scale';

export type { HeatScale, HeatScaleOptions } from './use-heat-scale';

export { ChartLegend, seriesDotBackground } from './chart-legend';

export type {
    ChartLegendProps,
    ChartLegendSeriesEntry,
    ChartLegendSeriesProps,
    ChartLegendGradientProps,
} from './chart-legend';

// ─── Roadmap-21 PR-E — 3D foundation ────────────────────────────────
//
// `<Chart3D>` wraps react-three-fiber's <Canvas> with SSR-safe
// dynamic import + prefers-reduced-motion fallback + constrained
// OrbitControls. `tokenColor()` resolves a chart-series CSS var to
// a hex string Three.js materials can consume. Three.js + drei +
// r3f only load on routes that mount a 3D chart (~180KB gzipped,
// dynamic-imported via `dynamicChart3D()`).

export { Chart3D, tokenColor } from './chart-3d';

export type { Chart3DProps } from './chart-3d';

export { dynamicChart3D } from './chart-3d-dynamic';

// PR-F — first 3D chart: BarField3D (cross-tab time × category bars).
export { BarField3D } from './bar-field-3d';

export type { BarField3DDatum, BarField3DProps } from './bar-field-3d';

// ─── Shared scale / layout helpers (Epic 59) ─────────────────────────
//
// Pure helpers charts (and non-chart consumers that need to speak the
// same scale or margin vocabulary) compose. Exported as values + as a
// namespace so a downstream component can either pick individual
// helpers or reach for the whole module via an alias import.

export {
    AXIS_LABEL_FONT_SIZE,
    COMPACT_CHART_MARGIN,
    DEFAULT_AREA_Y_PADDING,
    DEFAULT_BAR_Y_PADDING,
    DEFAULT_CHART_MARGIN,
    DEFAULT_Y_AXIS_TICK_AXIS_SPACING,
    buildTimeSeriesXScale,
    buildYScale,
    computeYDomain,
    formatNumericTick,
    formatShortDate,
    getDateExtent,
    getFactors,
    pickXAxisTickCount,
    pickXAxisTickValues,
    pickYAxisTickCount,
    resolveChartMargin,
    resolveChartPadding,
} from './layout';

// ─── Shared interaction primitives (Epic 59) ─────────────────────────
//
// Hover + keyboard state hooks, and token-backed tooltip surface
// components that every chart consumer should reach for so the
// dashboard reads as one system rather than a patchwork of tooltip
// implementations.

export {
    ChartTooltipContainer,
    ChartTooltipRow,
    useChartHover,
    useChartKeyboardNavigation,
} from './interaction';

export type {
    ChartHoverState,
    ChartKeyboardNavigationOptions,
    ChartKeyboardNavigationReturn,
    ChartTooltipContainerProps,
    ChartTooltipRowProps,
} from './interaction';

// ─── Public types ─────────────────────────────────────────────────────
//
// Visx-tied primitives the TimeSeriesChart / Funnel primitives consume
// internally, plus the Epic 59 consumer contracts (point shapes,
// dimensions, tooltip payloads, progress metrics, KPI metrics, state).

export type {
    // Visx-tied internals
    AccessorFn,
    ChartContext as ChartContextType,
    ChartProps,
    ChartTooltipContext as ChartTooltipContextType,
    Data,
    Datum,
    Series,
    TimeSeriesDatum,
    // Consumer contracts
    CategoryPoint,
    ChartDimensions,
    ChartMargin,
    ChartPadding,
    ChartState,
    KpiMetric,
    LabeledSeries,
    ProgressMetric,
    ProgressSegment,
    SparklineData,
    TimeSeriesPoint,
    TooltipPayload,
} from './types';

// ─── Chart-state constructors + narrowing ────────────────────────────

export {
    chartEmpty,
    chartError,
    chartLoading,
    chartReady,
    isChartReady,
} from './types';
