"use client";

/**
 * TrendCard — compact KPI trend tile powered by the Epic 59 chart platform.
 *
 * Renders a header row (label + current value) above a 48px-tall
 * interactive time-series sparkline. Composes `<TimeSeriesChart>` +
 * `<Areas>` with the compact margin preset so the area fill eats
 * almost the full tile height but still gives tooltip/hover room.
 *
 * Designed to be dropped into any dashboard trend row — not just the
 * executive dashboard. The caller owns the colour-class choice so the
 * same card can carry brand / success / warning / error semantics
 * without bespoke forks.
 *
 * Example:
 *
 *   <TrendCard
 *       label="Coverage"
 *       value={75.3}
 *       format="%"
 *       points={[{ date, value }, ...]}
 *       colorClassName="text-content-success"
 *   />
 */

import {
    Areas,
    COMPACT_CHART_MARGIN,
    TimeSeriesChart,
    type TimeSeriesDatum,
} from "@/components/ui/charts";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { formatDate } from "@inflect/ui/lib/format-date";
import { useMemo } from "react";
import { useTranslations } from "next-intl";

export interface TrendCardProps {
    /** Header label, e.g. "Coverage". */
    label: string;
    /** Current (latest) value shown in the header row. */
    value: number;
    /** Suffix for the current value, e.g. `%`. */
    format?: string;
    /** Ordered oldest→newest series of dated values. */
    points: ReadonlyArray<{ date: Date; value: number }>;
    /** Tailwind `text-*` class — drives the area fill/line colour. */
    colorClassName: string;
}

type TrendDatum = TimeSeriesDatum<{ value: number }>;

export function TrendCard({
    label,
    value,
    format,
    points,
    colorClassName,
}: TrendCardProps) {
    const t = useTranslations("common.chart");
    const data = useMemo<TrendDatum[]>(
        () => points.map((p) => ({ date: p.date, values: { value: p.value } })),
        [points],
    );

    const series = useMemo(
        () => [
            {
                id: "trend",
                isActive: true,
                valueAccessor: (d: TrendDatum) => d.values.value,
                colorClassName,
            },
        ],
        [colorClassName],
    );

    const suffix = format ?? "";
    const ariaLabel = t("trendAria", { label });

    return (
        <div className="space-y-1" data-trend-card>
            <div className="flex items-baseline justify-between">
                <span className="text-xs text-content-muted">{label}</span>
                <span className="text-sm font-semibold text-content-emphasis tabular-nums">
                    <AnimatedNumber
                        value={value}
                        // TrendCard only knows the suffix as a string,
                        // not a structured format. Use the `intl`
                        // passthrough with no constraints — preserves
                        // whatever digit shape the caller passed
                        // (integers stay integer, decimals stay
                        // decimal). The suffix prop carries the unit.
                        format={{ kind: 'intl', options: {} }}
                        suffix={suffix}
                    />
                </span>
            </div>
            <div
                className="relative h-12 w-full"
                role="img"
                aria-label={ariaLabel}
            >
                <TimeSeriesChart
                    data={data}
                    series={series}
                    type="area"
                    margin={COMPACT_CHART_MARGIN}
                    tooltipContent={(d) =>
                        `${d.values.value}${suffix} — ${formatDate(d.date)}`
                    }
                    emptyState={
                        <div className="h-px w-full bg-border-subtle" data-trend-empty />
                    }
                >
                    <Areas showLatestValueCircle />
                </TimeSeriesChart>
            </div>
        </div>
    );
}
