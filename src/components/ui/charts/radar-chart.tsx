'use client';

/**
 * Roadmap-16 PR-9 — `<RadarChart>` primitive.
 *
 * The R16 radar chart. Visualises a multi-axis profile (e.g.
 * control coverage by domain, risk profile by category) as a
 * polygon mesh inside a circular grid.
 *
 * Renders:
 *
 *   - Concentric circular grid lines at 25%, 50%, 75%, 100% of
 *     the outer radius. Muted via `--border-subtle` so they
 *     orient the reader without competing with the data
 *     polygon.
 *
 *   - One radial axis line per data point, running from the
 *     centre to the outer radius. Same muted tone as the grid.
 *
 *   - Axis labels at the outer end of each radial line, rendered
 *     via `@visx/text` for clean kerning + automatic
 *     anti-collision wrapping.
 *
 *   - The data polygon — a closed path connecting each axis's
 *     value-scaled point. Fill paints via a radial gradient
 *     (R16-PR2) centred at the chart centre so the brighter
 *     start-stop concentrates inside the polygon, deepening
 *     toward its outer vertices.
 *
 *   - Vertex circles at each (axis, value) point — solid fill
 *     in the series start-stop so individual data points are
 *     readable against the gradient polygon. R16-PR10 (next)
 *     adds hover-pop + axis-line highlight.
 *
 * Visual choices:
 *
 *   - The polygon's stroke is `--chart-series-{N}-end` at 100%
 *     opacity so the outline is crisp against the lighter fill.
 *
 *   - Grid lines and axis lines are at 0.6 opacity — present
 *     enough to read, light enough not to compete with the
 *     polygon.
 *
 * Wraps in `<ChartFrame>` for state-driven branch rendering.
 */
import { useId, useState, type ReactNode } from 'react';
import { Group } from '@visx/group';
import { Line } from '@visx/shape';
import { Text } from '@visx/text';
import { motion } from 'motion/react';

import { ChartFrame } from './chart-frame';
import {
    ChartRadialGradient,
    chartGradientId,
    type ChartSeriesIndex,
} from './chart-gradient';
import { useChartHoverPop } from './chart-motion';
import type { ChartState } from './types';

/**
 * Default number of concentric rings in the grid. Four gives a
 * clear read for 0-100% style profiles without crowding the radar.
 *
 * Pass `rings` to override — a chart whose scale IS a ladder wants
 * one ring per rung so the grid reads as the scale itself (the
 * dashboard posture radar passes 5).
 */
const GRID_RINGS = 4;

/**
 * Margins reserved for the axis labels, which are drawn OUTSIDE the
 * outer ring (see `labelAnchorFor`).
 *
 * Horizontal and vertical are separate because the labels are: a side
 * label runs along the x-axis and needs room for a word, a top or bottom
 * one needs room for a line of text. Reserving the horizontal figure on
 * all four sides — the original single square `inset` — threw away
 * vertical space and shrank the dial for nothing.
 *
 * The horizontal margin SCALES with the chart, between a floor and a
 * ceiling. A fixed number cannot serve both consumers: 58px starves a
 * wide chart's long domain names ("Supply chain security" wrapping four
 * times) while a value generous enough for those would leave a 300px
 * dashboard dial tiny. 18% of the width, clamped to 48-84, gives each
 * chart a margin proportional to what it has.
 *
 * The horizontal margin is also the wrap width handed to visx `Text`, so
 * a long label breaks onto another line instead of running off the SVG.
 */
const H_INSET_MIN = 48;
const H_INSET_MAX = 84;
const H_INSET_RATIO = 0.18;
const V_INSET = 28;

function horizontalInset(width: number): number {
    return Math.min(H_INSET_MAX, Math.max(H_INSET_MIN, width * H_INSET_RATIO));
}

/**
 * Gap between the outer ring and the near edge of a label.
 *
 * 14, not 10: a vertex sitting AT the outer ring (a 100% axis) is a
 * 4px-radius dot centred on the ring, so a 10px gap left ~3px of white
 * between dot and text — measured, and too close to read as separate
 * things. 14 gives ~7px, and `V_INSET` is sized to keep the bottom
 * label inside the SVG at that distance.
 */
const LABEL_GAP = 14;

/**
 * Anchor a label by which side of the dial it sits on, so text
 * always grows AWAY from the plot.
 *
 * `middle` is correct only at the top and bottom of the dial, where
 * the label extends sideways into empty margin. Everywhere else a
 * centred anchor pulls half the string back over the polygon. The
 * 0.2 cosine cut-off is ~±78° from vertical — wide enough that the
 * near-vertical axes of a 5- or 6-axis dial stay centred.
 */
function labelAnchorFor(cos: number, sin: number) {
    if (cos > 0.2) return { textAnchor: 'start' as const, verticalAnchor: 'middle' as const };
    if (cos < -0.2) return { textAnchor: 'end' as const, verticalAnchor: 'middle' as const };
    return {
        textAnchor: 'middle' as const,
        // Above the dial the text hangs upward from its baseline;
        // below it, downward. Without this the top label's descenders
        // cross the ring.
        verticalAnchor: sin < 0 ? ('end' as const) : ('start' as const),
    };
}

/**
 * Default vertex circle radius (px).
 */
const VERTEX_RADIUS = 4;

export interface RadarAxisDatum {
    /** Stable axis key — used as React key + for hover state in PR-10. */
    key: string;
    /** Visible axis label rendered at the outer edge. */
    label: string;
    /** Value at this axis. Normalised to 0..1 vs. the chart's max. */
    value: number;
}

interface RadarChartProps {
    /** Discriminated data state — wraps the axes array. */
    state: ChartState<RadarAxisDatum[]>;
    /** R16 series index (1..6) for the polygon fill + stroke. */
    seriesIndex: ChartSeriesIndex;
    /**
     * Optional max value. When omitted, the chart uses 1 (i.e. the
     * `value` field is already 0..1). Set to e.g. 100 if your
     * values are percentages.
     */
    maxValue?: number;
    /** Outer wrapper className (forwarded to ChartFrame). */
    className?: string;
    /** data-testid for the outer wrapper. */
    testId?: string;
    /** Optional aria-label override on the SVG. */
    ariaLabel?: string;
    /** Override the empty-state body (forwarded to ChartFrame). */
    emptyFallback?: ReactNode;
    /**
     * Concentric grid rings. Defaults to `GRID_RINGS` (4). Set it to
     * the number of rungs when the scale IS a ladder — then a vertex
     * sitting on the third ring literally means level 3.
     */
    rings?: number;
    /**
     * Frame height floor, forwarded to `<ChartFrame>` (default 240).
     *
     * This is the ONLY way to size the chart: `<ChartFrame>` puts its
     * measured area in `position: absolute` so the frame resolves to its
     * own min-height and ignores a fixed height on the parent. Wrapping
     * the chart in `h-[300px]` therefore bought 60px of dead space under
     * the dial rather than a bigger dial — measured, and the reason the
     * hero's metrics floated 87px below the chart they belong to.
     */
    minHeight?: number | null;
}

/**
 * Multi-axis radar chart with gradient polygon fill.
 *
 * Consumer pattern:
 *
 *     const state = useControlCoverageByDomain();  // ChartState<RadarAxisDatum[]>
 *     return (
 *       <RadarChart
 *         state={state}
 *         seriesIndex={2}
 *         maxValue={100}
 *         testId="control-coverage-radar"
 *         ariaLabel="Control coverage by domain"
 *       />
 *     );
 */
export function RadarChart({
    state,
    seriesIndex,
    maxValue = 1,
    className,
    testId,
    ariaLabel,
    emptyFallback,
    rings = GRID_RINGS,
    minHeight,
}: RadarChartProps) {
    return (
        <ChartFrame
            state={state}
            className={className}
            testId={testId}
            emptyFallback={emptyFallback}
            minHeight={minHeight}
        >
            {({ width, height, data }) => (
                <RadarChartInner
                    width={width}
                    height={height}
                    data={data}
                    seriesIndex={seriesIndex}
                    maxValue={maxValue}
                    ariaLabel={ariaLabel}
                    rings={rings}
                />
            )}
        </ChartFrame>
    );
}

interface RadarChartInnerProps {
    width: number;
    height: number;
    data: RadarAxisDatum[];
    seriesIndex: ChartSeriesIndex;
    maxValue: number;
    ariaLabel?: string;
    rings: number;
}

function RadarChartInner({
    width,
    height,
    data,
    seriesIndex,
    maxValue,
    ariaLabel,
    rings,
}: RadarChartInnerProps) {
    const reactId = useId();
    const chartId = `radar-${reactId.replace(/:/g, '')}`;
    const fillGradId = chartGradientId(chartId, seriesIndex, 'radial');

    // R16-PR10 — vertex + axis hover state. Keyed by axis key so
    // hovering either the vertex circle OR its axis line / label
    // engages the same row of affordances (highlighted axis,
    // popped vertex).
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const pop = useChartHoverPop({ hoveredKey });

    if (data.length === 0) return null;

    const cx = width / 2;
    const cy = height / 2;
    // Bound by whichever margin runs out first — horizontal room for a
    // side label, vertical room for a line above/below the dial.
    const hInset = horizontalInset(width);
    const outerRadius = Math.max(
        0,
        Math.min(width / 2 - hInset, height / 2 - V_INSET),
    );

    // Angle per axis. -PI/2 starts the first axis at 12 o'clock
    // (top), then we rotate clockwise. The 2π / N spacing makes
    // any number of axes lay out symmetrically.
    const angleStep = (Math.PI * 2) / data.length;
    const angleFor = (idx: number) => -Math.PI / 2 + idx * angleStep;

    // For each axis, compute the outer-edge point and the value-
    // scaled point. valueRadius scales the axis value into the
    // outer-radius range.
    const points = data.map((d, idx) => {
        const angle = angleFor(idx);
        const valueRadius = (d.value / maxValue) * outerRadius;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return {
            key: d.key,
            label: d.label,
            value: d.value,
            angle,
            // Outer-edge point (for axis lines + labels).
            edgeX: cx + cos * outerRadius,
            edgeY: cy + sin * outerRadius,
            // Value-scaled point (vertex of the data polygon).
            valueX: cx + cos * valueRadius,
            valueY: cy + sin * valueRadius,
            // Label position — past the outer ring by LABEL_GAP,
            // anchored so the text grows AWAY from the plot. A
            // centred anchor here put half of every side label back
            // over the ring, on top of the vertex dot.
            labelX: cx + cos * (outerRadius + LABEL_GAP),
            labelY: cy + sin * (outerRadius + LABEL_GAP),
            ...labelAnchorFor(cos, sin),
        };
    });

    // Build the polygon path connecting each value-point.
    const polygonPath =
        points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.valueX} ${p.valueY}`).join(' ') +
        ' Z';

    // Build N concentric grid circles. Could be rings but the
    // straight-line "spider-web" layout reads as more honest
    // for a radar.
    const ringCount = Math.max(1, Math.round(rings));
    const gridRings = Array.from({ length: ringCount }, (_, i) => {
        const ringRadius = ((i + 1) / ringCount) * outerRadius;
        return ringRadius;
    });

    return (
        <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel ?? 'Radar chart'}
        >
            <defs>
                <ChartRadialGradient
                    id={fillGradId}
                    series={seriesIndex}
                    // Brighter start-stop concentrates at the
                    // centre — the polygon glows from within.
                    cx="50%"
                    cy="50%"
                    // Slightly tighter than 100% so the brighter
                    // colour shows on the polygon body.
                    r="60%"
                />
            </defs>

            <Group>
                {/* Concentric grid rings. Muted; orient the eye. */}
                {gridRings.map((r) => (
                    <circle
                        key={r}
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill="none"
                        stroke="var(--border-subtle)"
                        strokeWidth={1}
                        opacity={0.6}
                    />
                ))}

                {/* Radial axis lines from centre to outer ring.
                    R16-PR10 — hovered axis brightens to the series
                    end-stop tone + bumps opacity so it stands out
                    from the muted resting ring. */}
                {points.map((p) => {
                    const isHovered = pop.isPopped(p.key);
                    return (
                        <Line
                            key={`axis-${p.key}`}
                            from={{ x: cx, y: cy }}
                            to={{ x: p.edgeX, y: p.edgeY }}
                            stroke={
                                isHovered
                                    ? `var(--chart-series-${seriesIndex}-end)`
                                    : 'var(--border-subtle)'
                            }
                            strokeWidth={isHovered ? 1.5 : 1}
                            opacity={isHovered ? 1 : 0.6}
                            style={{
                                transition:
                                    'stroke 200ms ease-out, opacity 200ms ease-out, stroke-width 200ms ease-out',
                            }}
                        />
                    );
                })}

                {/* Data polygon. Gradient fill + crisp end-stop
                    stroke so the outline reads against the
                    lighter fill interior. */}
                <path
                    d={polygonPath}
                    fill={`url(#${fillGradId})`}
                    fillOpacity={0.45}
                    stroke={`var(--chart-series-${seriesIndex}-end)`}
                    strokeWidth={2}
                    strokeLinejoin="round"
                />

                {/* Vertex circles at each (axis, value) point.
                    R16-PR10 — pop on hover via useChartHoverPop's
                    point scale (1.05× — subtle). Event handlers
                    wire pointer + focus so vertex hover engages
                    the same affordances as axis-line / label
                    hover (one shared hoveredKey). */}
                {points.map((p) => {
                    const scale = pop.getPointScale(p.key);
                    return (
                        <motion.circle
                            key={`vertex-${p.key}`}
                            cx={p.valueX}
                            cy={p.valueY}
                            r={VERTEX_RADIUS}
                            fill={`var(--chart-series-${seriesIndex}-start)`}
                            stroke="var(--bg-default)"
                            strokeWidth={1.5}
                            animate={{ scale }}
                            transition={{
                                duration: 0.2,
                                ease: 'easeOut',
                            }}
                            style={{
                                transformOrigin: `${p.valueX}px ${p.valueY}px`,
                                cursor: 'pointer',
                            }}
                            onMouseEnter={() => setHoveredKey(p.key)}
                            onMouseLeave={() => setHoveredKey(null)}
                            onFocus={() => setHoveredKey(p.key)}
                            onBlur={() => setHoveredKey(null)}
                            tabIndex={0}
                            role="img"
                            aria-label={`${p.label}: ${p.value}`}
                        />
                    );
                })}

                {/* Axis labels — visx Text handles auto-anchor +
                    line-wrapping if a label needs it.
                    R16-PR10 — hovered label brightens from muted
                    to emphasis tone. Whole label is also clickable
                    via the wrapping <g> so the hover row stays
                    consistent across vertex / axis / label. */}
                {points.map((p) => {
                    const isHovered = pop.isPopped(p.key);
                    return (
                        <g
                            key={`label-${p.key}`}
                            onMouseEnter={() => setHoveredKey(p.key)}
                            onMouseLeave={() => setHoveredKey(null)}
                            onFocus={() => setHoveredKey(p.key)}
                            onBlur={() => setHoveredKey(null)}
                            tabIndex={0}
                            style={{ cursor: 'pointer', outline: 'none' }}
                        >
                            <Text
                                x={p.labelX}
                                y={p.labelY}
                                textAnchor={p.textAnchor}
                                verticalAnchor={p.verticalAnchor}
                                fontSize={11}
                                // Wrap inside the reserved margin rather
                                // than running off the SVG.
                                width={hInset - LABEL_GAP}
                                fontFamily="Inter, system-ui, sans-serif"
                                fill={
                                    isHovered
                                        ? 'var(--content-emphasis)'
                                        : 'var(--content-muted)'
                                }
                                style={{
                                    transition: 'fill 200ms ease-out',
                                    fontWeight: isHovered ? 600 : 400,
                                }}
                            >
                                {p.label}
                            </Text>
                        </g>
                    );
                })}
            </Group>
        </svg>
    );
}
