"use client";

import { cn } from "@inflect/ui/lib/cn";
import { curveNatural } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { Group } from "@visx/group";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleUtc } from "@visx/scale";
import { Area, AreaClosed } from "@visx/shape";
import { motion } from "motion/react";
import { useId, useMemo } from "react";

import type { SparklineData, TimeSeriesPoint } from "@/components/ui/charts";
import { ChartGloss, chartGlossId } from "@/components/ui/charts/chart-gloss";

/**
 * Epic 59 — compact sparkline for KPI cards and summary tiles.
 *
 * Renders a small token-backed area chart (no axes, no ticks, no
 * tooltip) sized to whatever the parent gives it. Designed to sit
 * inside a KPI card's value row, a table cell's trend column, or a
 * compact dashboard widget. Handles empty data by rendering a bare
 * baseline rather than throwing.
 *
 * Example:
 *
 *   <MiniAreaChart
 *       data={[
 *           { date: new Date('2026-04-01'), value: 70 },
 *           { date: new Date('2026-04-02'), value: 72 },
 *           ...
 *       ]}
 *       variant="success"
 *       aria-label="Coverage trend — last 30 days"
 *   />
 */

export type MiniAreaChartVariant =
    | "brand"
    | "success"
    | "warning"
    | "error"
    | "info"
    | "neutral";

/**
 * Padding around the chart's drawable region (`innerHeight` = host
 * height − top − bottom). Top + bottom are LOAD-BEARING — they
 * reserve breathing room for `curveNatural`'s overshoot. Spline
 * interpolation can pass a few pixels BELOW the data minimum (and
 * a few pixels ABOVE the maximum); without that breathing room
 * the SVG viewBox clips the stroke at the very lowest / highest
 * point of the curve, visibly fading the line.
 *
 * Top stayed at `6` since R18. Bottom was `2`, which was enough
 * for shallow curves but too tight for steep down-slopes (the
 * Dashboard "Risks" tile reported the lower curve fading at the
 * minima). Bumped to `4` for symmetry-ish — top still gets more
 * because labels above the chart need MORE clearance than the
 * baseline below. A regression ratchet locks `bottom >= 4`.
 */
const DEFAULT_PADDING = { top: 6, right: 2, bottom: 4, left: 2 };

interface MiniAreaChartProps {
    data: SparklineData | TimeSeriesPoint[];
    /** Status variant — drives the stroke + fill colour token. */
    variant?: MiniAreaChartVariant;
    /** Natural-curve smoothing on the line. Defaults to true. */
    curve?: boolean;
    /** Padding around the drawable area (in px). */
    padding?: Partial<typeof DEFAULT_PADDING>;
    /**
     * Explicit y-axis domain `[min, max]`. By default each sparkline auto-fits
     * its OWN [min, max], which shows relative shape but hides absolute scale —
     * so a flat-at-2 and a flat-at-90 series render identically. Pass a SHARED
     * domain (e.g. `[0, maxAcrossAllCards]`) across a row of cards to make them
     * comparable: a small series sits low, a large one high.
     */
    yDomain?: [number, number];
    /** Accessible label. Sparklines *must* carry one — the caller owns the meaning. */
    "aria-label": string;
    /** Extra classes on the outer wrapper. */
    className?: string;
}

// ─── Variant token table ─────────────────────────────────────────────

const VARIANT_TEXT: Record<MiniAreaChartVariant, string> = {
    brand: "text-brand-emphasis",
    success: "text-content-success",
    warning: "text-content-warning",
    error: "text-content-error",
    info: "text-content-info",
    neutral: "text-content-muted",
};

// ─── Y-domain resolution ─────────────────────────────────────────────

/**
 * Resolve the sparkline's y-axis `[min, max]` domain.
 *
 * - With an explicit `override` (a SHARED domain across a row of cards), use
 *   it verbatim — absolute scale is preserved, so a flat-at-2 series sits low
 *   and a flat-at-90 series sits high.
 * - Otherwise auto-fit the series' own `[min, max]` (relative shape only).
 * - A constant series (`min === max`, and no override) gets a small synthetic
 *   range so it draws a centred horizontal line rather than a point.
 *
 * Exported + pure so the scale logic is unit-testable without DOM layout
 * (`<ParentSize>` renders 0×0 under jsdom).
 */
export function resolveYDomain(
    values: number[],
    override?: [number, number],
): [number, number] {
    if (override) return override;
    let minY = values[0];
    let maxY = values[0];
    for (const v of values) {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
    }
    if (minY === maxY) return [minY - 1, maxY + 1];
    return [minY, maxY];
}

// ─── Component ───────────────────────────────────────────────────────

export function MiniAreaChart(props: MiniAreaChartProps) {
    return (
        <ParentSize className={cn("relative", props.className)}>
            {({ width, height }) => {
                if (width <= 0 || height <= 0) return null;
                return <MiniAreaChartInner {...props} width={width} height={height} />;
            }}
        </ParentSize>
    );
}

function MiniAreaChartInner({
    width,
    height,
    data,
    variant = "brand",
    curve = true,
    padding: paddingProp,
    yDomain,
    "aria-label": ariaLabel,
}: MiniAreaChartProps & { width: number; height: number }) {
    const padding = { ...DEFAULT_PADDING, ...paddingProp };
    const id = useId();
    const innerWidth = Math.max(0, width - padding.left - padding.right);
    const innerHeight = Math.max(0, height - padding.top - padding.bottom);

    const zeroedData = useMemo(
        () => data.map(({ date }) => ({ date, value: 0 })),
        [data],
    );

    const { yScale, xScale } = useMemo(() => {
        if (data.length === 0) {
            // Hooks must run every render; return stable scales so
            // downstream code can skip the draw branch safely.
            return {
                yScale: scaleLinear<number>({
                    domain: [0, 1],
                    range: [innerHeight, 0],
                }),
                xScale: scaleUtc<number>({
                    domain: [new Date(0), new Date(1)],
                    range: [0, innerWidth],
                }),
            };
        }
        const [minY, maxY] = resolveYDomain(
            data.map(({ value }) => value),
            yDomain,
        );

        const dateTimes = data.map(({ date }) => date.getTime());
        const minDate = new Date(Math.min(...dateTimes));
        const maxDate = new Date(Math.max(...dateTimes));

        return {
            yScale: scaleLinear<number>({
                domain: [minY, maxY],
                range: [innerHeight, 0],
                nice: true,
                clamp: true,
            }),
            xScale: scaleUtc<number>({
                domain: [minDate, maxDate],
                range: [0, innerWidth],
            }),
        };
    }, [data, innerHeight, innerWidth]);

    // Empty data — render a bare baseline rather than an empty SVG.
    if (data.length === 0) {
        return (
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel}
                data-mini-chart
                data-mini-chart-empty
                className={cn(VARIANT_TEXT[variant])}>
                <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={height / 2}
                    y2={height / 2}
                    stroke="var(--border-subtle)"
                    strokeDasharray="2 3"
                    strokeWidth={1}
                />
            </svg>
        );
    }

    return (
        <svg
            width={width}
            height={height}
            key={data.length}
            role="img"
            aria-label={ariaLabel}
            data-mini-chart
            className={cn(VARIANT_TEXT[variant])}>
            <defs>
                {/* Area fill — currentColor flowing from the variant class. */}
                <LinearGradient
                    id={`${id}-fill-gradient`}
                    from="currentColor"
                    to="currentColor"
                    fromOpacity={0.3}
                    toOpacity={0}
                    x1={0}
                    x2={0}
                    y1={0}
                    y2={1}
                />
                {/* R18-PR6 — liquid-fill gloss. A `subtle` vertical
                    sheen painted as an OVERLAY on the area fill so
                    the filled region reads as a glossy liquid
                    surface catching light from above. `subtle`
                    (0.18 peak) because sparklines are tiny + dense
                    — a `default` sheen would wash out the variant
                    colour at this size. */}
                <ChartGloss
                    id={chartGlossId(id)}
                    direction="vertical"
                    intensity="subtle"
                />
            </defs>
            <Group left={padding.left} top={padding.top}>
                <AreaClosed
                    data={data as TimeSeriesPoint[]}
                    x={({ date }) => xScale(date) ?? 0}
                    y={({ value }) => yScale(value) ?? 0}
                    yScale={yScale}
                    curve={curve ? curveNatural : undefined}>
                    {({ path }) => (
                        <>
                            {/* Colour layer — the variant-tinted
                                area fill. Morphs `d` from a flat
                                zeroed baseline up to the data
                                shape: the "liquid filling up". */}
                            <motion.path
                                initial={{ d: path(zeroedData) || "", opacity: 0 }}
                                animate={{ d: path(data as TimeSeriesPoint[]) || "", opacity: 1 }}
                                fill={`url(#${id}-fill-gradient)`}
                            />
                            {/* R18-PR6 — gloss layer. SAME `d`
                                animation, painted on top, filled
                                with the subtle vertical gloss —
                                the liquid surface catches light.
                                Tracks the colour layer's `d` morph
                                so the sheen "fills up" with the
                                liquid. aria-hidden + no opacity
                                init flicker: it rides the colour
                                layer's reveal. */}
                            <motion.path
                                initial={{ d: path(zeroedData) || "" }}
                                animate={{ d: path(data as TimeSeriesPoint[]) || "" }}
                                fill={`url(#${chartGlossId(id)})`}
                                aria-hidden="true"
                                style={{ pointerEvents: "none" }}
                            />
                        </>
                    )}
                </AreaClosed>
                <Area
                    data={data as TimeSeriesPoint[]}
                    x={({ date }) => xScale(date) ?? 0}
                    y={({ value }) => yScale(value) ?? 0}
                    curve={curve ? curveNatural : undefined}>
                    {({ path }) => (
                        <motion.path
                            initial={{ d: path(zeroedData) || "", opacity: 0 }}
                            animate={{ d: path(data as TimeSeriesPoint[]) || "", opacity: 1 }}
                            stroke="currentColor"
                            strokeWidth={1.5}
                            fill="none"
                        />
                    )}
                </Area>
            </Group>
        </svg>
    );
}
