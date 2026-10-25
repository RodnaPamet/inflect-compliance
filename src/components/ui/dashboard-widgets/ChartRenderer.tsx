"use client";

/**
 * Epic 41 — `<ChartRenderer>`.
 *
 * Typed dispatcher over the existing Inflect chart platform (Epic 59).
 * The renderer takes a discriminated `(chartType, config)` payload
 * and routes to the right primitive:
 *
 *   - kpi    → `<KpiCard>`      (`@/components/ui/KpiCard`)
 *   - donut  → `<DonutChart>`   (`@/components/ui/DonutChart`)
 *   - area   → `<TimeSeriesChart type="area">` with `<Areas>`
 *              (+ optional `<TargetLine>` overlay)
 *
 * Why no Recharts: a CI guardrail
 * (`tests/guardrails/chart-platform-foundation.test.ts`) explicitly
 * bans recharts / chart.js / victory / nivo / etc. — Inflect committed
 * to ONE chart system at Epic 59. Adding Recharts here would (a) fail
 * CI immediately and (b) create a parallel-libraries problem. The
 * renderer below provides the same caller contract a Recharts
 * dispatcher would, but composed from existing primitives.
 *
 * Lifecycle states (`loading | empty | error | ready`) are surfaced
 * as caller-provided `state` + `error` props so the dispatcher can
 * sit inside any data-fetching shape (SWR, server-rendered, etc.)
 * without coupling to one. The `ready` default ensures static
 * payloads render without ceremony.
 *
 * Malformed config: when a `chartType`'s `config` doesn't satisfy the
 * runtime requirements (e.g. donut with zero segments), the renderer
 * falls through to its empty state rather than throwing — dashboards
 * never crash because one widget's payload is wrong.
 */

import { useTranslations } from 'next-intl';
import KpiCard from '@/components/ui/KpiCard';
import DonutChart from '@/components/ui/DonutChart';
import {
    Areas,
    TimeSeriesChart,
    XAxis,
    YAxis,
    type Series,
    type TimeSeriesDatum,
} from '@/components/ui/charts';

import type { ChartRendererProps } from './types';
import { TargetLine } from './TargetLine';

// ─── Lifecycle skeletons ────────────────────────────────────────────

function LoadingState({ label }: { label?: string }) {
    return (
        <div
            data-chart-loading
            role="status"
            aria-busy="true"
            className="flex h-full w-full items-center justify-center px-6 py-8"
        >
            <div className="space-y-tight text-center">
                <div className="mx-auto h-3 w-24 animate-pulse rounded bg-bg-muted" />
                <div className="mx-auto h-2 w-32 animate-pulse rounded bg-bg-muted" />
                {label && (
                    <p className="sr-only">{label}</p>
                )}
            </div>
        </div>
    );
}

function EmptyStateInline({ label }: { label?: string }) {
    return (
        <div
            data-chart-empty
            role="status"
            className="flex h-full w-full items-center justify-center px-6 py-8 text-center text-sm text-content-muted"
        >
            {label ?? 'No data available.'}
        </div>
    );
}

function ErrorStateInline({ message }: { message: string }) {
    return (
        <div
            data-chart-error
            role="alert"
            className="flex h-full w-full items-center justify-center px-6 py-8 text-center text-sm text-content-error"
        >
            {message}
        </div>
    );
}

// ─── Time-series helper ─────────────────────────────────────────────
//
// Normalises a `{date, value}[]` payload into the chart-platform's
// `TimeSeriesDatum<{value: number}>` shape and a single-series
// definition. Time-series-chart filters by `isActive: true`, so the
// flag is set on the synthetic series.

interface TimeSeriesPoint extends Record<string, number> {
    value: number;
}

function buildTimeSeriesData(
    points: ReadonlyArray<{ date: Date; value: number }>,
): TimeSeriesDatum<TimeSeriesPoint>[] {
    return points.map((p) => ({ date: p.date, values: { value: p.value } }));
}

function buildTimeSeriesSeries(
    seriesId: string,
    seriesColorClassName: string | undefined,
): Series<TimeSeriesPoint>[] {
    return [
        {
            id: seriesId,
            isActive: true,
            valueAccessor: (d) => d.values.value,
            colorClassName: seriesColorClassName ?? 'text-brand-default',
        },
    ];
}

// ─── Renderer ───────────────────────────────────────────────────────

export function ChartRenderer(props: ChartRendererProps) {
    // KpiCard takes no translator of its own (#3209 tranche 3), so the
    // accessible names for its trend and loading states are resolved here.
    const tUi = useTranslations('common.ui');
    const state = props.state ?? 'ready';

    // Lifecycle short-circuit. The KPI card has its own dim "—" empty
    // path that's softer than the platform's `EmptyStateInline`, so we
    // let the KPI primitive own the empty state when its `value` is
    // null/undefined. Other chart types funnel through the inline
    // states above.
    if (state === 'loading') {
        return <LoadingState label={props['aria-label']} />;
    }
    if (state === 'error') {
        return (
            <ErrorStateInline message={props.error ?? 'Failed to load chart.'} />
        );
    }
    if (state === 'empty' && props.chartType !== 'kpi') {
        return <EmptyStateInline />;
    }

    // ── Ready ──────────────────────────────────────────────────────

    switch (props.chartType) {
        case 'kpi': {
            const c = props.config;
            return (
                <KpiCard
                    label={c.label}
                    trendAriaLabel={tUi('kpiTrend30Day', { label: c.label })}
                    value={c.value}
                    format={c.format}
                    icon={c.icon}
                    gradient={c.gradient}
                    subtitle={c.subtitle}
                    delta={c.delta}
                    deltaLabel={c.deltaLabel}
                    previousValue={c.previousValue}
                    trendPolarity={c.trendPolarity}
                    trend={c.sparkline}
                    trendVariant={c.sparklineVariant}
                    className={props.className}
                />
            );
        }

        case 'donut': {
            const c = props.config;
            // Malformed-config fallback: DonutChart already empty-states
            // at total === 0, but we add an explicit guard for the
            // segments-array-missing case so a buggy config map doesn't
            // crash the page.
            if (!Array.isArray(c.segments) || c.segments.length === 0) {
                return <EmptyStateInline />;
            }
            return (
                <DonutChart
                    segments={c.segments as ReadonlyArray<{ label: string; value: number; color: string }> & Array<{ label: string; value: number; color: string }>}
                    size={c.size}
                    centerLabel={c.centerLabel}
                    centerSub={c.centerSub}
                    showLegend={c.showLegend}
                    className={props.className}
                />
            );
        }

        case 'area': {
            const c = props.config;
            const data = buildTimeSeriesData(c.points);
            const series = buildTimeSeriesSeries(
                c.seriesId ?? 'series',
                c.seriesColorClassName,
            );
            return (
                <TimeSeriesChart<TimeSeriesPoint>
                    data={data}
                    series={series}
                    type="area"
                    emptyState={c.emptyState}
                    className={props.className}
                >
                    <YAxis showGridLines />
                    <Areas />
                    {/* Optional target-line overlay. Renders inside
                     *  the chart's SVG via the chart context. The
                     *  TargetLine component is a no-op-cheap import
                     *  when `target` is undefined. */}
                    {c.target ? (
                        <TargetLine
                            value={c.target.value}
                            label={c.target.label}
                            polarity={c.target.polarity}
                        />
                    ) : null}
                    <XAxis />
                </TimeSeriesChart>
            );
        }

        default: {
            // Unreachable under TypeScript narrowing — a runtime cast
            // (e.g. an unsafe DTO mapping) is the only way to land
            // here. Rendering an explicit error chip is friendlier
            // than a silent blank.
            const exhaustiveCheck: never = props;
            void exhaustiveCheck;
            return (
                <ErrorStateInline message="Unsupported chart type." />
            );
        }
    }
}

// Re-export the public types so a consumer pulls everything from
// `@/components/ui/dashboard-widgets`.
export type { ChartRendererProps } from './types';
export type { ChartType, ChartRenderState } from './types';
