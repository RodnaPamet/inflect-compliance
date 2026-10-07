/**
 * Epic 59 — shared chart layout helpers.
 *
 * Every chart surface in the app (`TimeSeriesChart`, `FunnelChart`,
 * `mini-area-chart`, future sparkline + KPI visuals) lands on the
 * same set of layout decisions: how much margin to reserve, how to
 * pad the y-domain, how many ticks the x/y axis should carry at a
 * given size, how to build a date or band scale from source data.
 *
 * This module is the single place those answers live. Axis and chart
 * primitives import from here so no one re-derives tick densities or
 * margin defaults inline — fixing one density curve or tightening
 * one default flows to every chart that composes these helpers.
 *
 * The module is pure, deterministic, and visx-free at the type level
 * (we only pull `@visx/scale` for the scale builders themselves) so
 * it can be unit-tested without a DOM.
 */

import { scaleBand, scaleLinear, scaleUtc } from '@visx/scale';

import { formatDateCompact } from '../../../lib/format-date';

import type {
    ChartMargin,
    ChartPadding,
    Data,
    Datum,
    Series,
} from './types';

// ─── Enterprise-dashboard defaults ────────────────────────────────────
//
// Chosen for the ~240-360 px tall widgets dashboards render at and
// the dense 12-col grids the reporting surfaces use. Dashboards
// optimise for scan-ability: tick labels sit tight against the
// chart area, the top margin leaves headroom for the highest data
// point, the bottom margin carries the x-axis label row.

/** Default pixel margins around the chart area. */
export const DEFAULT_CHART_MARGIN: ChartMargin = {
    top: 12,
    right: 5,
    bottom: 32,
    left: 5,
};

/** Default pixel margins for compact / mini chart contexts. */
export const COMPACT_CHART_MARGIN: ChartMargin = {
    top: 4,
    right: 4,
    bottom: 4,
    left: 4,
};

/** Decimal percent padding above / below the y-extent for `area` charts. */
export const DEFAULT_AREA_Y_PADDING: ChartPadding = { top: 0.1, bottom: 0.1 };

/** Decimal percent padding for `bar` charts — zero-bottom keeps bars grounded. */
export const DEFAULT_BAR_Y_PADDING: ChartPadding = { top: 0.1, bottom: 0 };

/** Canonical axis label font size — matches the UI body/caption scale. */
export const AXIS_LABEL_FONT_SIZE = 12;

/** Spacing between a y-axis tick label and the plotted area. */
export const DEFAULT_Y_AXIS_TICK_AXIS_SPACING = 8;

// ─── Margin + padding resolution ─────────────────────────────────────

/**
 * Merge a user-provided partial margin with the module defaults and
 * optionally reserve extra pixels on the left for the y-axis label
 * column (the y-axis computes its own label width at mount and writes
 * it into ChartContext; the host chart then expands the left margin
 * by that amount).
 */
export function resolveChartMargin(
    margin?: Partial<ChartMargin>,
    leftAxisReserve?: number,
): ChartMargin {
    const base = { ...DEFAULT_CHART_MARGIN, ...(margin ?? {}) };
    if (leftAxisReserve && leftAxisReserve > 0) {
        return { ...base, left: base.left + leftAxisReserve };
    }
    return base;
}

/**
 * Pick the default y-domain padding for a given chart type. `area`
 * charts pad top + bottom so the line doesn't graze the edges; `bar`
 * charts pad top only so the bars stay rooted at zero.
 */
export function resolveChartPadding(
    type: 'area' | 'bar',
    padding?: Partial<ChartPadding>,
): ChartPadding {
    const base = type === 'area' ? DEFAULT_AREA_Y_PADDING : DEFAULT_BAR_Y_PADDING;
    return { ...base, ...(padding ?? {}) };
}

// ─── Domain helpers ──────────────────────────────────────────────────

/** Compute the earliest + latest date in a dataset. */
export function getDateExtent<T extends Datum>(data: Data<T>): {
    startDate: Date;
    endDate: Date;
} {
    if (data.length === 0) {
        const now = new Date();
        return { startDate: now, endDate: now };
    }
    let min = data[0].date;
    let max = data[0].date;
    for (let i = 1; i < data.length; i++) {
        const d = data[i].date;
        if (d.getTime() < min.getTime()) min = d;
        if (d.getTime() > max.getTime()) max = d;
    }
    return { startDate: min, endDate: max };
}

/**
 * Compute the raw `{ minY, maxY }` extent across every active series.
 * `bar` charts always include zero in the minimum so stacked bars stay
 * rooted; `area` charts return the naive min so dense series don't
 * waste vertical space.
 */
export function computeYDomain<T extends Datum>({
    data,
    series,
    type,
}: {
    data: Data<T>;
    series: Series<T>[];
    type: 'area' | 'bar';
}): { minY: number; maxY: number } {
    const activeSeries = series.filter((s) => s.isActive !== false);
    if (data.length === 0 || activeSeries.length === 0) {
        return { minY: 0, maxY: 0 };
    }

    const values: number[] = [];
    for (const d of data) {
        if (type === 'bar') {
            let sum = 0;
            for (const s of activeSeries) {
                const v = s.valueAccessor(d);
                if (v != null) sum += v;
            }
            values.push(sum);
        } else {
            for (const s of activeSeries) {
                const v = s.valueAccessor(d);
                if (v != null) values.push(v);
            }
        }
    }

    if (values.length === 0) return { minY: 0, maxY: 0 };

    let min = values[0];
    let max = values[0];
    for (let i = 1; i < values.length; i++) {
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
    }

    return {
        minY: type === 'area' ? min : Math.min(0, min),
        maxY: max,
    };
}

// ─── Scale builders ──────────────────────────────────────────────────

/**
 * Build the y-axis linear scale. Pads the domain by the supplied
 * decimal percent top/bottom, sets `nice: true` so ticks align, and
 * clamps outputs to the plot area.
 */
export function buildYScale({
    minY,
    maxY,
    padding,
    height,
}: {
    minY: number;
    maxY: number;
    padding: ChartPadding;
    height: number;
}) {
    const range = maxY - minY;
    return scaleLinear<number>({
        domain: [
            minY - range * (padding.bottom ?? 0),
            maxY + range * (padding.top ?? 0),
        ],
        range: [height, 0],
        nice: true,
        clamp: true,
    });
}

/**
 * Build the x-axis scale for a time-series chart. `area` charts use
 * a continuous UTC scale; `bar` charts use a discrete band scale so
 * each datum lands on its own column.
 */
export function buildTimeSeriesXScale<T extends Datum>({
    data,
    startDate,
    endDate,
    width,
    type,
}: {
    data: Data<T>;
    startDate: Date;
    endDate: Date;
    width: number;
    type: 'area' | 'bar';
}) {
    if (type === 'area') {
        return scaleUtc<number>({
            domain: [startDate, endDate],
            range: [0, width],
        });
    }
    return scaleBand<Date>({
        domain: data.map((d) => d.date),
        range: [0, width],
        padding: 0.15,
        align: 0.5,
    });
}

// ─── Tick density ────────────────────────────────────────────────────

/**
 * Pick a sensible max x-axis tick count for a given plot width.
 * Enterprise dashboards run at ~240-360 px chart height and 420-720 px
 * wide widgets; below 450 px we cap at 4 ticks, between 450-600 we
 * allow 6, above 600 we go up to 8. Keeps labels from colliding.
 */
export function pickXAxisTickCount(width: number): number {
    if (width < 450) return 4;
    if (width < 600) return 6;
    return 8;
}

/**
 * Pick a sensible y-axis tick count for a given plot height. Short
 * widgets (sparklines, compact KPI tiles) round down to 3 ticks;
 * standard dashboard widgets use 4. The yScale's `nice: true` may
 * round this further — treat it as an upper bound.
 */
export function pickYAxisTickCount(height: number): number {
    return height < 350 ? 3 : 4;
}

// ─── Whole-factor helper (pure math, kept for x-axis tick selection) ──

/**
 * All positive whole factors of a non-negative integer. Used by the
 * x-axis to pick an even every-nth tick step without dropping the
 * final label. Unit-tested in `tests/unit/chart-layout-helpers.test.ts`.
 */
export function getFactors(n: number): number[] {
    if (!Number.isFinite(n) || n < 0) return [];
    const out: number[] = [];
    for (let i = 1; i <= n; i++) {
        if (n % i === 0) out.push(i);
    }
    return out;
}

/**
 * Pick an evenly-spaced subset of dates from the chart's data array
 * so that at most `maxTicks` land on the x-axis. When the dataset is
 * smaller than `2 * maxTicks`, falls back to just the first + last
 * datum so the endpoints always label.
 */
export function pickXAxisTickValues<T extends Datum>(
    data: Data<T>,
    maxTicks: number,
): Date[] {
    if (data.length === 0) return [];
    if (data.length === 1) return [data[0].date];

    const tickInterval =
        getFactors(data.length).find((f) => (data.length + 1) / f <= maxTicks) ??
        1;

    const twoTicks = data.length / tickInterval < 2;

    return data
        .filter((_, idx, { length }) =>
            twoTicks
                ? idx === 0 || idx === length - 1
                : (idx + 1) % tickInterval === 0,
        )
        .map(({ date }) => date);
}

// ─── Default formatters ──────────────────────────────────────────────

/**
 * Default x-axis tick formatter — "16 Apr". Delegates to the canonical
 * `formatDateCompact` from `@/lib/format-date` so every calendar
 * surface in the app — chart axes, filter pills, range-picker
 * triggers — shares the same `en-GB` + `UTC` calendar. Charts that
 * need the long app-wide form ("16 Apr 2026") should pass their own
 * `tickFormat` built from `formatDate`.
 *
 * Migrated from an inline `toLocaleDateString('en-US', …)` that
 * produced "Apr 16" with the host timezone. The swap fixes a latent
 * SSR-hydration mismatch (server + browser may disagree on "today"
 * when rendered across a UTC midnight boundary) and unifies axis
 * labels with the rest of the app chrome.
 */
export function formatShortDate(date: Date): string {
    return formatDateCompact(date);
}

/** Default y-axis tick formatter — `value.toString()`. */
export function formatNumericTick(value: number): string {
    return value.toString();
}
