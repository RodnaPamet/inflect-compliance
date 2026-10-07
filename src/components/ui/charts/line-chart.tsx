'use client';

/**
 * Roadmap-16 PR-7 — `<LineChart>` primitive.
 *
 * The R16 lickable line chart. Renders a single series (a date →
 * value array) as:
 *
 *   - A smooth `curveCatmullRom` stroke painted with the
 *     R16-PR1 series colour. No sharp corners — the catmull-rom
 *     interpolation passes through every data point but smooths
 *     the in-between geometry.
 *
 *   - An area under the line filled with a vertical gradient
 *     that fades from the series start-stop (top) to fully
 *     transparent (bottom). The "fade-to-floor" feel that says
 *     "this is a trend, not a histogram".
 *
 *   - On mount: the line path draws itself left-to-right over
 *     600 ms via `stroke-dashoffset` animation. The area fades
 *     in alongside. Once drawn, the line stays static until
 *     R16-PR8 wires hover crosshair + focus-point pulse.
 *
 * The primitive wraps in `<ChartFrame>` so consumers thread a
 * single `ChartState` prop and get loading / empty / error
 * branches for free.
 *
 * What's NOT in this PR:
 *
 *   - Hover crosshair + focus-point pulse. PR-8.
 *   - Multi-series stacking. Single-series only for now.
 *   - X / Y axis labels. The primitive currently renders the
 *     line + area only — consumers can layer their own axes
 *     on top via the existing R16 `<XAxis>` / `<YAxis>` from
 *     the chart-platform barrel if they need axes.
 */
import { useTranslations } from 'next-intl';
import { useCallback, useId, useMemo, useState, type MouseEvent } from 'react';
import { Group } from '@visx/group';
import { scaleLinear, scaleUtc } from '@visx/scale';
import { Area, Line, LinePath } from '@visx/shape';
import { curveCatmullRom } from '@visx/curve';
import { localPoint } from '@visx/event';
import { bisector } from 'd3-array';
import { motion } from 'motion/react';

import { ChartFrame } from './chart-frame';
import {
    ChartLinearGradient,
    chartGradientId,
    type ChartSeriesIndex,
} from '@inflect/ui/components/ui/charts/chart-gradient';
import { ChartGloss, chartGlossId } from '@inflect/ui/components/ui/charts/chart-gloss';
import { CHART_HOVER_POINT_SCALE } from '@inflect/ui/components/ui/charts/chart-motion';
import type { ChartState, TimeSeriesPoint } from '@inflect/ui/components/ui/charts/types';

/**
 * Default padding around the chart contents. Tighter than the
 * frame's outer padding — the frame's `p-4` is for the chrome,
 * this padding is for the chart's interior margin.
 */
const DEFAULT_PADDING = { top: 12, right: 12, bottom: 12, left: 12 };

/**
 * Mount animation duration. Matches `--chart-mount-duration: 600ms`
 * from R16-PR1. Locked here as a fallback for SSR / tests where
 * CSS vars don't resolve.
 */
const MOUNT_DURATION_MS = 600;

interface LineChartProps {
    /** Discriminated data state. Wraps the data array. */
    state: ChartState<TimeSeriesPoint[]>;
    /** R16 series index (1..6) for the line stroke + area fill. */
    seriesIndex: ChartSeriesIndex;
    /** Outer wrapper className (forwarded to <ChartFrame>). */
    className?: string;
    /** data-testid for the outer wrapper. */
    testId?: string;
    /** Optional aria-label override on the SVG. */
    ariaLabel?: string;
    /**
     * Whether to render the area under the line. Defaults to true.
     * Set false for a stroke-only sparkline (line + nothing
     * beneath).
     */
    showArea?: boolean;
}

/**
 * Smooth single-series line chart with area-under-line gradient
 * fade and on-mount path draw.
 *
 * Consumer pattern:
 *
 *     const state = useReadinessTrend();  // ChartState<TimeSeriesPoint[]>
 *     return (
 *       <LineChart
 *         state={state}
 *         seriesIndex={1}
 *         testId="readiness-trend"
 *         ariaLabel="Readiness over last 30 days"
 *       />
 *     );
 */
export function LineChart({
    state,
    seriesIndex,
    className,
    testId,
    ariaLabel,
    showArea = true,
}: LineChartProps) {
    return (
        <ChartFrame state={state} className={className} testId={testId}>
            {({ width, height, data }) => (
                <LineChartInner
                    width={width}
                    height={height}
                    data={data}
                    seriesIndex={seriesIndex}
                    ariaLabel={ariaLabel}
                    showArea={showArea}
                />
            )}
        </ChartFrame>
    );
}

interface LineChartInnerProps {
    width: number;
    height: number;
    data: TimeSeriesPoint[];
    seriesIndex: ChartSeriesIndex;
    ariaLabel?: string;
    showArea: boolean;
}

/**
 * The actual rendering. Lifted into a component so the hover
 * state hooks can run inside a real React component (the render-
 * prop callback is just a function, not a component, so hooks
 * inside it would violate the rules of hooks).
 */
function LineChartInner({
    width,
    height,
    data,
    seriesIndex,
    ariaLabel,
    showArea,
}: LineChartInnerProps) {
    const t = useTranslations('common.chart');
    const reactId = useId();
    const chartId = `line-${reactId.replace(/:/g, '')}`;
    const strokeGradId = chartGradientId(chartId, seriesIndex, 'linear');
    const areaGradId = `${chartId}-area`;

    const padding = DEFAULT_PADDING;
    const innerWidth = Math.max(0, width - padding.left - padding.right);
    const innerHeight = Math.max(0, height - padding.top - padding.bottom);

    // R16-PR8 — hover state. Tracks which data-point index is
    // currently focused (or null). Pointer-driven via the
    // transparent overlay below; bisector finds the nearest
    // point to the cursor's x-position.
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    // R16-PR8 — bisector to find the data-point nearest to a
    // given x-coordinate. Memoised so the comparator function
    // doesn't reallocate every render.
    const dateBisector = useMemo(
        () => bisector<TimeSeriesPoint, Date>((d) => d.date).center,
        [],
    );

    const scales = useMemo(() => {
        if (data.length === 0) return null;
        const xExtent = [data[0]!.date, data[data.length - 1]!.date] as [
            Date,
            Date,
        ];
        const yValues = data.map((d) => d.value);
        const yMin = Math.min(...yValues);
        const yMax = Math.max(...yValues);
        const yPadding = (yMax - yMin) * 0.1 || 1;
        return {
            xScale: scaleUtc({
                domain: xExtent,
                range: [0, innerWidth],
            }),
            yScale: scaleLinear({
                domain: [yMin - yPadding, yMax + yPadding],
                range: [innerHeight, 0],
                clamp: true,
            }),
        };
    }, [data, innerWidth, innerHeight]);

    const handlePointerMove = useCallback(
        (event: MouseEvent<SVGRectElement>) => {
            if (!scales) return;
            const point = localPoint(event);
            if (!point) return;
            // localPoint returns SVG-coordinate space; subtract
            // the chart's inner-padding to get the position
            // inside the plot area.
            const xInsidePlot = point.x - padding.left;
            const date = scales.xScale.invert(xInsidePlot);
            const idx = dateBisector(data, date);
            if (idx >= 0 && idx < data.length) {
                setHoveredIndex(idx);
            }
        },
        [scales, dateBisector, data, padding.left],
    );

    const handlePointerLeave = useCallback(() => {
        setHoveredIndex(null);
    }, []);

    if (data.length === 0 || !scales) return null;

    const { xScale, yScale } = scales;
    const x = (d: TimeSeriesPoint) => xScale(d.date);
    const y = (d: TimeSeriesPoint) => yScale(d.value);
    const y0 = () => innerHeight;

    const hoveredPoint =
        hoveredIndex !== null ? data[hoveredIndex] : null;
    const hoveredX = hoveredPoint ? xScale(hoveredPoint.date) : 0;
    const hoveredY = hoveredPoint ? yScale(hoveredPoint.value) : 0;

    return (
                    <svg
                        width={width}
                        height={height}
                        role="img"
                        aria-label={ariaLabel ?? t('lineChartAria')}
                    >
                        <defs>
                            {/* Stroke gradient — horizontal so the
                                series tone shifts subtly from
                                left-to-right along the trend. */}
                            <ChartLinearGradient
                                id={strokeGradId}
                                series={seriesIndex}
                                direction="horizontal"
                            />
                            {/* Area gradient — vertical, fading
                                from the series start-stop at the
                                top to fully transparent at the
                                bottom. R16-PR1's
                                <ChartLinearGradient> doesn't
                                directly express transparency, so
                                we build this one inline using the
                                series CSS-var stops. */}
                            <linearGradient
                                id={areaGradId}
                                x1="0%"
                                y1="0%"
                                x2="0%"
                                y2="100%"
                            >
                                <stop
                                    offset="0%"
                                    stopColor={`var(--chart-series-${seriesIndex}-start)`}
                                    stopOpacity={0.45}
                                />
                                <stop
                                    offset="60%"
                                    stopColor={`var(--chart-series-${seriesIndex}-end)`}
                                    stopOpacity={0.15}
                                />
                                <stop
                                    offset="100%"
                                    stopColor={`var(--chart-series-${seriesIndex}-end)`}
                                    stopOpacity={0}
                                />
                            </linearGradient>
                            {/* R18-PR7 — area gloss. A vertical
                                sheen painted as an overlay on the
                                area-under-line so the filled
                                region reads as a glossy surface,
                                same two-layer paint as the donut
                                + mini-area. `default` intensity:
                                the LineChart is a full-size chart,
                                not a tiny sparkline. */}
                            <ChartGloss
                                id={chartGlossId(chartId)}
                                direction="vertical"
                                intensity="default"
                            />
                        </defs>

                        <Group left={padding.left} top={padding.top}>
                            {/* Area under the line — fades in on
                                mount alongside the line draw. */}
                            {showArea && (
                                <motion.g
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{
                                        duration: MOUNT_DURATION_MS / 1000,
                                        ease: 'easeOut',
                                    }}
                                >
                                    {/* Colour layer — the series
                                        area gradient. */}
                                    <Area
                                        data={data}
                                        x={x}
                                        y0={y0}
                                        y1={y}
                                        curve={curveCatmullRom}
                                        fill={`url(#${areaGradId})`}
                                    />
                                    {/* R18-PR7 — gloss layer. Same
                                        Area geometry, painted on
                                        top, filled with the gloss
                                        def. The white→transparent
                                        ramp gives the filled
                                        region a glass sheen near
                                        the top edge. aria-hidden +
                                        pointer-events:none — it
                                        carries light, not data,
                                        and must not intercept the
                                        plot-area hover overlay. */}
                                    <Area
                                        data={data}
                                        x={x}
                                        y0={y0}
                                        y1={y}
                                        curve={curveCatmullRom}
                                        fill={`url(#${chartGlossId(chartId)})`}
                                        aria-hidden="true"
                                        pointerEvents="none"
                                    />
                                </motion.g>
                            )}

                            {/* Line path. The path-draw animation
                                runs via framer-motion's
                                `pathLength` which works on
                                `<motion.path>` directly. We use
                                visx's LinePath render-prop API
                                to obtain the generated d-string
                                and feed it into <motion.path>. */}
                            <LinePath
                                data={data}
                                x={x}
                                y={y}
                                curve={curveCatmullRom}
                            >
                                {({ path }) => {
                                    const d = path(data);
                                    if (d === null) return null;
                                    return (
                                        <motion.path
                                            d={d}
                                            stroke={`url(#${strokeGradId})`}
                                            strokeWidth={2}
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            fill="none"
                                            initial={{ pathLength: 0 }}
                                            animate={{ pathLength: 1 }}
                                            transition={{
                                                duration:
                                                    MOUNT_DURATION_MS / 1000,
                                                ease: 'easeOut',
                                            }}
                                        />
                                    );
                                }}
                            </LinePath>

                            {/* R16-PR8 — crosshair + focus point.
                                Renders only when a point is
                                hovered. The vertical crosshair
                                marks the x-position; the focus
                                point pulses via the R16-PR4
                                hover-point scale (1.05×). */}
                            {hoveredPoint && (
                                <>
                                    <Line
                                        from={{ x: hoveredX, y: 0 }}
                                        to={{ x: hoveredX, y: innerHeight }}
                                        stroke="var(--content-muted)"
                                        strokeWidth={1}
                                        strokeDasharray="3 3"
                                        opacity={0.6}
                                        pointerEvents="none"
                                    />
                                    {/* R18-PR7 — bubbly focus
                                        point. The hover dot scales
                                        in through a SPRING (not
                                        the prior plain ease-out)
                                        so it overshoots its target
                                        size and settles — it
                                        "bubbles out" toward the
                                        pointer. `stiffness` +
                                        `damping` tuned so the
                                        overshoot is visible but
                                        the dot settles inside the
                                        same ~200ms window the old
                                        ease-out used. The spring
                                        starts from `scale: 0` (not
                                        1) so the bubble grows from
                                        nothing — a 1→1.05 spring
                                        would barely register. */}
                                    <motion.circle
                                        cx={hoveredX}
                                        cy={hoveredY}
                                        r={5}
                                        fill={`url(#${strokeGradId})`}
                                        stroke="var(--bg-default)"
                                        strokeWidth={2}
                                        initial={{ scale: 0, opacity: 0 }}
                                        animate={{
                                            scale: CHART_HOVER_POINT_SCALE,
                                            opacity: 1,
                                        }}
                                        transition={{
                                            scale: {
                                                type: 'spring',
                                                stiffness: 520,
                                                damping: 16,
                                            },
                                            opacity: {
                                                duration: 0.12,
                                                ease: 'easeOut',
                                            },
                                        }}
                                        style={{
                                            transformOrigin: `${hoveredX}px ${hoveredY}px`,
                                        }}
                                        pointerEvents="none"
                                    />
                                </>
                            )}

                            {/* R16-PR8 — transparent overlay
                                captures pointer events across
                                the full plot area. visx's
                                localPoint resolves to the SVG's
                                coordinate space; we subtract
                                padding.left to get plot-relative
                                x, then bisect to find the nearest
                                data point. */}
                            <rect
                                width={innerWidth}
                                height={innerHeight}
                                fill="transparent"
                                onMouseMove={handlePointerMove}
                                onMouseLeave={handlePointerLeave}
                                onTouchMove={
                                    handlePointerMove as unknown as (
                                        e: React.TouchEvent<SVGRectElement>,
                                    ) => void
                                }
                                onTouchEnd={handlePointerLeave}
                            />
                        </Group>
                    </svg>
    );
}
