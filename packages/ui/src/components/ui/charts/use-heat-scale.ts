/**
 * Roadmap-21 PR-A — `useHeatScale` foundation hook.
 *
 * Maps a numeric value within a `[min, max]` domain to a CSS color
 * string interpolated between two chart-series tokens. The result
 * is theme-agnostic: the tokens (`--chart-series-${N}-start` and
 * `--chart-series-${N}-end`) flip with the theme, and the
 * `color-mix(in oklab, ...)` interpolation runs in CSS at render
 * time — no JS reads of computed styles, no per-frame work.
 *
 * Why this exists. R21 PR-C rebuilds both RiskHeatmap and
 * CalendarHeatmap; both need a value-to-color mapping that:
 *   (a) reads from the R16 chart-token palette so heatmaps speak
 *       the same colour vocabulary as the rest of the chart
 *       family;
 *   (b) gives a smooth perceptual ramp (oklab interpolation, not
 *       naive rgb);
 *   (c) exposes the same `gradientId` to a paired `<ChartLegend
 *       variant="gradient">` so the legend gradient and the cell
 *       fills are visually CONTINUOUS — not two arbitrary
 *       gradients that happen to look similar.
 *
 * Consumer contract:
 *
 *   const scale = useHeatScale({ domain: [0, 100], series: 1 });
 *   return (
 *     <>
 *       <ChartLegend variant="gradient" heatScale={scale} unit="%" />
 *       <svg>
 *         {cells.map(c => (
 *           <rect fill={scale.colorFor(c.value)} ... />
 *         ))}
 *       </svg>
 *     </>
 *   );
 *
 * No consumer wires this in PR-A — it lands purely as foundation.
 * RiskHeatmap + CalendarHeatmap consume it in PR-C; the R21-PR-A
 * ratchet locks the API surface so PR-C can wire to it without
 * fear of drift.
 */
import { useMemo } from 'react';

import type { ChartSeriesIndex } from './chart-gradient';

export interface HeatScaleOptions {
    /**
     * `[min, max]` of the input domain. Values outside the domain
     * are clamped — a count above `max` paints at full intensity,
     * a count below `min` paints at floor intensity.
     */
    domain: [number, number];
    /**
     * Which chart-series gradient (1..6) drives the heat ramp.
     * The R16 token palette uses 1 = warm yellow/orange, 2 = cool
     * cyan, 3 = violet, 4 = pink, 5 = green, 6 = amber.
     * Default: 1 (brand-warm — the canonical "risk" hue).
     */
    series?: ChartSeriesIndex;
    /**
     * Number of legend ticks. Default 5. Visual-only; doesn't
     * affect the cell colour interpolation, which stays continuous.
     */
    steps?: number;
    /**
     * Floor / ceiling for the OPACITY channel of the interpolated
     * colour. A value at the bottom of the domain paints at the
     * floor (default 0.15 — visible but quiet); a value at the
     * top paints at the ceiling (default 1.0). Lets the heatmap
     * dim "no activity" cells without dropping them entirely.
     */
    range?: [number, number];
    /**
     * Unique gradient id prefix for the legend's SVG `<defs>`.
     * Required to avoid id collisions when multiple heatmaps
     * mount on one page. Conventionally `${chartId}-heat`.
     */
    idPrefix?: string;
}

export interface HeatScale {
    /**
     * Map a domain value to a CSS colour string. Uses
     * `color-mix(in oklab, end alpha%, start)` so the
     * interpolation is theme-agnostic — the start/end tokens flip
     * with the theme automatically.
     *
     * Modern browsers required: Chrome 111+, Safari 16.4+,
     * Firefox 113+. The codebase's other token-driven primitives
     * already assume the same baseline (e.g. R16 chart gradients
     * use OKLAB via SVG's `gradient-interpolation-method`).
     */
    colorFor: (value: number) => string;
    /**
     * Map a domain value to a `[0, 1]` intensity score (clamped).
     * Useful when a consumer needs the raw progress (e.g. for a
     * tooltip's "73% intensity" line) without rendering the cell.
     */
    intensityFor: (value: number) => number;
    /**
     * SVG `<linearGradient>` id the legend's `<defs>` block must
     * use. Composed as `${idPrefix}-stripe` so the legend gradient
     * and the cell fills are visually continuous.
     */
    gradientId: string;
    /**
     * The two source CSS-var names — exposed so a `<ChartLegend>`
     * (or a future custom legend) can paint the gradient strip
     * with the same start/end the cells consume.
     */
    startVar: string;
    endVar: string;
    /**
     * Discrete step values along the domain for legend ticks.
     * Length = `steps + 1` (inclusive of min and max).
     */
    stepValues: number[];
    /**
     * The series index in use — re-exposed so a downstream
     * component can pick a matching `<ChartLinearGradient>` for
     * a different visual context (e.g. a sparkline overlay).
     */
    series: ChartSeriesIndex;
    /**
     * The configured domain — re-exposed for legend min/max
     * labels.
     */
    domain: [number, number];
}

/**
 * Pure-math interpolation helpers; extracted so the ratchet can
 * unit-test them without mounting a React component.
 */
export function clampIntensity(
    value: number,
    domain: [number, number],
    range: [number, number] = [0.15, 1],
): number {
    const [min, max] = domain;
    const [floor, ceiling] = range;
    if (max === min) return ceiling;
    const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return floor + (ceiling - floor) * t;
}

export function buildHeatColorMix(
    seriesIndex: ChartSeriesIndex,
    intensity: number,
): string {
    const start = `var(--chart-series-${seriesIndex}-start)`;
    const end = `var(--chart-series-${seriesIndex}-end)`;
    const pct = Math.round(intensity * 100);
    return `color-mix(in oklab, ${end} ${pct}%, ${start})`;
}

export function buildStepValues(
    domain: [number, number],
    steps: number,
): number[] {
    const [min, max] = domain;
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) {
        out.push(min + ((max - min) * i) / steps);
    }
    return out;
}

export function useHeatScale(opts: HeatScaleOptions): HeatScale {
    const {
        domain,
        series = 1,
        steps = 5,
        range = [0.15, 1],
        idPrefix = 'heat',
    } = opts;
    return useMemo<HeatScale>(() => {
        const startVar = `--chart-series-${series}-start`;
        const endVar = `--chart-series-${series}-end`;
        const gradientId = `${idPrefix}-stripe`;
        const stepValues = buildStepValues(domain, steps);
        return {
            colorFor: (value: number) =>
                buildHeatColorMix(series, clampIntensity(value, domain, range)),
            intensityFor: (value: number) =>
                clampIntensity(value, domain, range),
            gradientId,
            startVar,
            endVar,
            stepValues,
            series,
            domain,
        };
    }, [
        domain,
        series,
        steps,
        range,
        idPrefix,
    ]);
}
