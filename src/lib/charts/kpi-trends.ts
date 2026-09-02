'use client';

/**
 * Canonical KPI-card sparkline data layer.
 *
 * Every entity list page (Assets, Controls, Risks, Evidence, Policies,
 * Vendors, …) renders a row of `<KpiFilterCard>`s, and each card can show an
 * inline sparkline of that metric's REAL per-day history. The series come
 * from the daily `ComplianceSnapshot` job (one frozen point per 24h) via
 * `GET /dashboard/trends` — the same source the executive dashboard uses, NOT
 * a client-side replay of the loaded rows.
 *
 * This module is the ONE place that fetches + shapes that data, so the six
 * KPI pages share a single cached request and an identical, truthful sparkline
 * pipeline instead of each hand-rolling it.
 *
 *   const trends = useKpiTrends(tenantSlug);
 *   const spark = buildKpiSparklines(trends.data?.dataPoints, (d) => d.controlsTotal, {
 *       total: (d) => d.controlsTotal,
 *       implemented: (d) => d.controlsImplemented,
 *   });
 *   // <KpiFilterCard sparkline={spark.total}
 *   //                sparklineDomain={centeredSparklineDomain(spark.total)} />
 */

import useSWR from 'swr';
import type {
    TrendDataPoint,
    TrendPayload,
} from '@/app-layer/usecases/compliance-trends';
import type { TimeSeriesPoint } from '@/components/ui/charts';
import type { MiniAreaChartVariant } from '@/components/ui/mini-area-chart';
import { ApiClientError } from '@/lib/api-client';

/** Shared 30-day trends fetch — one cache entry across every KPI page. */
export function useKpiTrends(tenantSlug: string) {
    // Raw `useSWR` keyed by the resolved URL — tenant-scoped + shared so
    // every entity page reuses one fetch (this is a library hook taking an
    // explicit tenantSlug, not a context-bound component).
    return useSWR<TrendPayload>(
        `/api/t/${tenantSlug}/dashboard/trends?days=30`,
        async (url: string): Promise<TrendPayload> => {
            const res = await fetch(url);
            if (!res.ok) throw new ApiClientError('Failed to fetch KPI trends', 'fetch_failed', res.status);
            return res.json();
        },
        { dedupingInterval: 5 * 60_000 },
    );
}

/**
 * Shape a set of date-aligned per-card series from the trend points, trimming
 * the leading defaulted-zero prefix.
 *
 * Snapshot metric columns are `@default(0)` and were added on different dates,
 * so snapshots from before a column existed read `0` — a FALSE history that
 * renders as a fake "ramp from zero". `anchor` (the entity's total) defines
 * where real data begins: every series is sliced at the SAME index (first day
 * the total is > 0) so they stay date-aligned and start where data is real.
 * A fresh tenant (or < 2 real points) yields short series; `<KpiFilterCard>`
 * draws no sparkline below 2 points.
 */
export function buildKpiSparklines<K extends string>(
    points: readonly TrendDataPoint[] | undefined,
    anchor: (d: TrendDataPoint) => number,
    pickers: Record<K, (d: TrendDataPoint) => number>,
): Record<K, TimeSeriesPoint[]> {
    const pts = points ?? [];
    const firstReal = pts.findIndex((d) => anchor(d) > 0);
    const trimmed = firstReal < 0 ? [] : pts.slice(firstReal);
    const out = {} as Record<K, TimeSeriesPoint[]>;
    for (const key in pickers) {
        out[key] = trimmed.map((d) => ({
            date: new Date(d.date),
            value: pickers[key](d),
        }));
    }
    return out;
}

/**
 * Build ONE series for a NULLABLE metric (a column added forward-only, so
 * pre-existence snapshot rows read `null`). Trims the leading `null` prefix —
 * the sparkline starts where the column began being captured — and maps the
 * rest (a stray `null` after real data coalesces to 0). Returns `[]` while
 * there's still no data, so `<KpiFilterCard>` draws nothing until ≥ 2 points.
 */
export function buildKpiSparklineNullable(
    points: readonly TrendDataPoint[] | undefined,
    pick: (d: TrendDataPoint) => number | null,
): TimeSeriesPoint[] {
    const pts = points ?? [];
    const firstReal = pts.findIndex((d) => pick(d) != null);
    if (firstReal < 0) return [];
    return pts.slice(firstReal).map((d) => ({
        date: new Date(d.date),
        value: pick(d) ?? 0,
    }));
}

/**
 * The full sparkline colour palette — every distinct `MiniAreaChartVariant`.
 * `assignSparklineVariants` draws from this so a row of KPI cards never
 * repeats a colour (up to 6 cards; every entity page has ≤ 6).
 */
export const SPARKLINE_VARIANTS: readonly MiniAreaChartVariant[] = [
    'brand',
    'success',
    'warning',
    'error',
    'info',
    'neutral',
];

/**
 * Allocate a DISTINCT sparkline colour to each KPI card on a page.
 *
 * Without this, `<KpiFilterCard>` defaults every sparkline to `brand`, so a
 * row of cards reads as one colour (the pre-fix state on every page except
 * Assets). This shuffles the palette with `rng` (default `Math.random`, so the
 * allocation is RANDOM per call) and assigns one colour per key in order —
 * guaranteeing no two cards on the same page share a colour as long as there
 * are ≤ `SPARKLINE_VARIANTS.length` (6) keys. Beyond that it wraps (the only
 * case a repeat is unavoidable; no entity page has that many KPI cards).
 *
 * Call it ONCE per mount (memoise on `[]`) so the colours stay stable across
 * re-renders within a page view but reshuffle on the next load. `rng` is
 * injectable so the distinctness invariant is unit-testable deterministically.
 */
export function assignSparklineVariants<K extends string>(
    keys: readonly K[],
    rng: () => number = Math.random,
): Record<K, MiniAreaChartVariant> {
    // Fisher–Yates over a copy of the palette.
    const pal = [...SPARKLINE_VARIANTS];
    for (let i = pal.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pal[i], pal[j]] = [pal[j], pal[i]];
    }
    const out = {} as Record<K, MiniAreaChartVariant>;
    keys.forEach((k, i) => {
        out[k] = pal[i % pal.length];
    });
    return out;
}

/**
 * Centered y-domain for a KPI sparkline so a ROW of sparklines sit at the SAME
 * vertical level regardless of magnitude — the data's midpoint lands at the
 * vertical centre of every card. Returns `undefined` for a constant/empty
 * series (the chart's own auto-fit already centres those).
 */
export function centeredSparklineDomain(
    series: ReadonlyArray<{ value: number }> | undefined,
): [number, number] | undefined {
    if (!series || series.length === 0) return undefined;
    let min = series[0].value;
    let max = series[0].value;
    for (const { value } of series) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (min === max) return undefined; // constant → chart auto-fit centres it
    const pad = (max - min) * 0.5; // data occupies the middle ~50% band
    return [min - pad, max + pad];
}
