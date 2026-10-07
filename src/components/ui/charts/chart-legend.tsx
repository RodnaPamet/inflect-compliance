/**
 * Roadmap-21 PR-A — shared `<ChartLegend>` primitive.
 *
 * Two variants:
 *
 *   **`series`** — discrete swatch list for multi-series charts
 *     (line, radar, gantt, bar). Each entry pairs a color dot with
 *     a name. Today every chart consumer that needs a legend
 *     hand-rolls one; centralising it ensures the same dot shape,
 *     same gap rhythm, same typography across the dashboard.
 *
 *   **`gradient`** — a continuous-ramp legend strip for heatmaps.
 *     Composes a `<HeatScale>` directly (returned by
 *     `useHeatScale`) — the gradient strip is painted from the
 *     same `--chart-series-${N}-start/-end` tokens the cells use,
 *     so the legend and the heatmap are visually CONTINUOUS, not
 *     two arbitrary gradients that happen to look similar.
 *
 * No consumer wires this in PR-A — it lands purely as foundation.
 * R21 PR-B (Sankey) is the first series-legend consumer; R21 PR-C
 * (Heatmap rebuild) is the first gradient-legend consumer.
 *
 * Accessibility:
 *
 *   - The series variant uses `<ul>` + `<li>` so screen readers
 *     announce the count and entries naturally.
 *   - The gradient variant uses `role="img"` + `aria-label` because
 *     a gradient strip isn't naturally tabular; the label combines
 *     the optional `label` + domain min/max + unit.
 */
import type { ReactElement } from 'react';

import { cn } from '@inflect/ui/lib/cn';

import type { ChartSeriesIndex } from './chart-gradient';
import type { HeatScale } from './use-heat-scale';

export interface ChartLegendSeriesEntry {
    /** Display name for this series. */
    name: string;
    /**
     * The series index (1..6) — when set, the dot is painted using
     * the chart-series gradient via inline `background` CSS. Lets
     * the legend dot match the chart's actual stroke/fill.
     */
    index?: ChartSeriesIndex;
    /**
     * Override colour — accepts any valid CSS colour string
     * (`var(--brand-default)`, `#ff0000`, `rgb(...)`, etc.). When
     * set, takes precedence over `index`.
     */
    color?: string;
}

export interface ChartLegendSeriesProps {
    variant: 'series';
    series: ChartLegendSeriesEntry[];
    className?: string;
}

export interface ChartLegendGradientProps {
    variant: 'gradient';
    /** The shared `HeatScale` from `useHeatScale`. */
    heatScale: HeatScale;
    /** Optional descriptive label (e.g. "Risk score"). */
    label?: string;
    /** Optional unit suffix on the min/max labels (e.g. "%"). */
    unit?: string;
    className?: string;
}

export type ChartLegendProps =
    | ChartLegendSeriesProps
    | ChartLegendGradientProps;

/**
 * Compose the inline `background` CSS for a series-dot. Exposed for
 * the ratchet to verify the gradient composition without rendering.
 */
export function seriesDotBackground(
    entry: ChartLegendSeriesEntry,
): string | undefined {
    if (entry.color) return entry.color;
    if (entry.index !== undefined) {
        return `linear-gradient(135deg, var(--chart-series-${entry.index}-start), var(--chart-series-${entry.index}-end))`;
    }
    return undefined;
}

function ChartLegendSeries({
    series,
    className,
}: ChartLegendSeriesProps): ReactElement {
    return (
        <ul
            className={cn(
                'flex flex-wrap items-center gap-x-default gap-y-1 text-xs text-content-muted',
                className,
            )}
            data-chart-legend
            data-chart-legend-variant="series"
        >
            {series.map((entry, i) => (
                <li
                    key={`${entry.name}-${i}`}
                    className="inline-flex items-center gap-1.5"
                >
                    <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                        style={{ background: seriesDotBackground(entry) }}
                    />
                    <span>{entry.name}</span>
                </li>
            ))}
        </ul>
    );
}

function ChartLegendGradient({
    heatScale,
    label,
    unit,
    className,
}: ChartLegendGradientProps): ReactElement {
    const [min, max] = heatScale.domain;
    const fmt = (v: number) =>
        Number.isInteger(v) ? String(v) : v.toFixed(1);
    const minLabel = `${fmt(min)}${unit ?? ''}`;
    const maxLabel = `${fmt(max)}${unit ?? ''}`;
    const ariaLabel = label
        ? `${label}: ${minLabel} to ${maxLabel}`
        : `Scale: ${minLabel} to ${maxLabel}`;
    return (
        <div
            className={cn(
                'inline-flex flex-col gap-1 text-xs text-content-muted',
                className,
            )}
            data-chart-legend
            data-chart-legend-variant="gradient"
        >
            {label && (
                <span className="font-medium text-content-default">
                    {label}
                </span>
            )}
            <svg
                role="img"
                aria-label={ariaLabel}
                width={160}
                height={10}
                className="overflow-visible"
            >
                <defs>
                    <linearGradient
                        id={heatScale.gradientId}
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="0%"
                    >
                        <stop
                            offset="0%"
                            stopColor={`var(${heatScale.startVar})`}
                        />
                        <stop
                            offset="100%"
                            stopColor={`var(${heatScale.endVar})`}
                        />
                    </linearGradient>
                </defs>
                <rect
                    x={0}
                    y={0}
                    width={160}
                    height={10}
                    rx={3}
                    fill={`url(#${heatScale.gradientId})`}
                />
            </svg>
            <div className="flex justify-between font-mono text-[10px]">
                <span>{minLabel}</span>
                <span>{maxLabel}</span>
            </div>
        </div>
    );
}

export function ChartLegend(props: ChartLegendProps): ReactElement {
    if (props.variant === 'series') {
        return <ChartLegendSeries {...props} />;
    }
    return <ChartLegendGradient {...props} />;
}
