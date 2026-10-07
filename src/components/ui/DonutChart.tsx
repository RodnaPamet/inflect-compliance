/**
 * DonutChart — proportional distribution donut.
 *
 * R16-PR5 rebuild — internally rewritten on top of visx's `<Pie>`
 * + the R16 chart primitive layer. Two visible improvements over
 * the pre-R16 `stroke-dasharray` rendering:
 *
 *   1. **Gradient segments where adjacent series meet.** Each
 *      segment paints via a `<ChartRadialGradient>` from R16-PR2
 *      (start-stop concentrated near the inner edge, end-stop at
 *      the outer edge — lit-from-within feel). Adjacent series'
 *      end-stops are tuned per R16-PR1 adjacent-tonal pairing so
 *      the boundary between two segments reads as a continuous
 *      tonal surface, not a hard hue jump.
 *
 *   2. **Curved end-caps.** visx's `cornerRadius` rounds each
 *      slice's corners by 1.5px. The donut reads as polished
 *      jewellery rather than pie slices stamped out of cardboard.
 *
 * Back-compat: the existing `color` prop on `DonutSegment` keeps
 * working for callers that haven't adopted the R16 series palette
 * yet. New consumers should set `seriesIndex` (1..6) and let the
 * gradient layer handle the colour resolution.
 *
 * Loading + empty branches inherited from the pre-R16 version:
 *
 *   - `loading={true}` renders the `<ShimmerDots>` placeholder
 *     inside a same-size box so layout doesn't shift.
 *   - `total === 0` renders a quiet "No data" disc.
 *
 * @example
 * ```tsx
 * <DonutChart
 *     segments={[
 *         { label: 'Open',      value: 10, seriesIndex: 6 },
 *         { label: 'Mitigating', value: 5, seriesIndex: 5 },
 *         { label: 'Closed',    value: 3, seriesIndex: 3 },
 *     ]}
 *     centerLabel="10"
 *     centerSub="Open"
 *     size={160}
 * />
 * ```
 */

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
// @visx 4.0 drops deep `/lib/...` import paths (exports-map gated) — Pie is a
// named export off the package root now.
import { Pie } from '@visx/shape';
import { motion } from 'motion/react';
import {
    ChartFlowGradient,
    ChartRadialGradient,
    chartGradientId,
    type ChartSeriesIndex,
} from '@inflect/ui/components/ui/charts/chart-gradient';
import {
    ChartGloss,
    chartGlossId,
    ChartSheenSweep,
    chartSheenId,
} from '@inflect/ui/components/ui/charts/chart-gloss';
import {
    CHART_HOVER_POP_DISTANCE,
    useChartFlow,
    useChartHoverPop,
    useChartSheen,
    useChartSpring,
} from '@inflect/ui/components/ui/charts/chart-motion';
import { ShimmerDots } from '@/components/ui/shimmer-dots';

// ─── Props ──────────────────────────────────────────────────────────

export interface DonutSegment {
    /** Segment label (legend + accessibility). */
    label: string;
    /** Numeric value. */
    value: number;
    /**
     * Optional R16 series index (1..6). When set, the segment
     * paints via `<ChartRadialGradient>` resolving through the
     * R16-PR1 token palette. Recommended for new consumers.
     *
     * When omitted, the legacy `color` field is used. This keeps
     * pre-R16 callers working without an immediate migration.
     */
    seriesIndex?: ChartSeriesIndex;
    /**
     * Legacy / back-compat — CSS colour string (hex, rgb, or
     * `var(--token)`). Used only when `seriesIndex` is not set.
     * New consumers should reach for `seriesIndex` instead.
     */
    color: string;
    /**
     * Optional drill-through target for this slice. When set (and the
     * chart is given `onSegmentClick`), clicking the arc navigates —
     * e.g. the "Critical" severity slice → the risks list filtered to
     * critical. Purely a data carry; the chart primitive itself does
     * NOT import a router (nav stays with the caller's handler).
     */
    href?: string;
}

export interface DonutChartProps {
    /** Data segments. */
    segments: DonutSegment[];
    /** Diameter in px (default: 160). */
    size?: number;
    /** Stroke width for the arc (default: 20). */
    strokeWidth?: number;
    /** Center headline text (e.g. "75%"). */
    centerLabel?: string;
    /** Center subtitle text (e.g. "Coverage"). */
    centerSub?: string;
    /** Show legend below the chart. */
    showLegend?: boolean;
    /** Optional CSS class. */
    className?: string;
    /** Optional test-id. */
    id?: string;
    /**
     * Epic 64 — render `<ShimmerDots>` inside the donut frame
     * (preserving size for layout stability) while the underlying
     * data is still loading. Distinct from `segments=[]` which
     * renders the "No data" empty state.
     */
    loading?: boolean;
    /**
     * Drill-through handler. When provided, each slice that carries an
     * `href` becomes a keyboard-accessible link (Enter/Space + click)
     * that calls this with the clicked segment. The caller owns the
     * actual navigation so this shared primitive stays router-free.
     */
    onSegmentClick?: (segment: DonutSegment) => void;
}

// ─── Component ──────────────────────────────────────────────────────

export default function DonutChart({
    segments,
    size = 160,
    strokeWidth = 20,
    centerLabel,
    centerSub,
    showLegend = true,
    className = '',
    id,
    loading = false,
    onSegmentClick,
}: DonutChartProps) {
    const t = useTranslations('common.chart');
    // useId provides a unique-per-instance gradient id prefix so
    // multiple donuts on the same page don't collide on SVG defs.
    const reactId = useId();
    // useId returns `:r0:` style values — sanitise for SVG id use.
    const chartId = `donut-${reactId.replace(/:/g, '')}`;

    // R16-PR6 — hover state. Keyed by segment label so each segment
    // can opt in / out independently. `null` when nothing is
    // hovered. Consumers wire `onMouseEnter` / `onMouseLeave` on
    // each segment path; the resulting hoveredKey feeds the
    // motion hooks below.
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    // R16-PR6 — hover-pop transforms. The hovered segment
    // translates radially outward by `--chart-hover-pop-distance`
    // (4 px) in the direction of its mid-angle. Mid-angle math
    // happens inline below — visx provides `arc.startAngle` and
    // `arc.endAngle`, so `(start + end) / 2` is the mid.
    const pop = useChartHoverPop({ hoveredKey });

    // R16-PR6 — gradient flow. When a segment is hovered AND
    // has a seriesIndex, swap its fill from the resting radial
    // gradient to a flow gradient whose `gradientTransform`
    // translate animates over time (the "flowing river of
    // gradient colour" effect). The ref attaches to the flow
    // gradient `<linearGradient>` in the defs block below.
    //
    // Distance: the donut's diameter — the gradient at
    // userSpaceOnUse spans roughly that, so panning by diameter
    // returns the cyclic 3-stop pattern to its starting position.
    const hoveredSegment = segments.find((s) => s.label === hoveredKey);
    const flowSeries = hoveredSegment?.seriesIndex;
    const flowRef = useChartFlow({
        active: flowSeries !== undefined,
        distance: size,
        direction: 'horizontal',
    });

    // R18-PR5 — bubble-entrance. On mount the whole pie group
    // scales from 0 through an overshoot peak (~1.05) and settles
    // to 1 — the donut "bubbles in" rather than just appearing.
    // `useChartSpring` is SSR-safe: it returns 1 on the server +
    // first client render, so the markup matches the settled
    // chart; the spring only engages after the mount effect.
    // prefers-reduced-motion → returns 1 immediately (no entrance).
    const entranceProgress = useChartSpring();

    // R18-PR10 — periodic sheen sweep. A narrow white band pans
    // slowly across the donut on a ~5s loop — ambient polish, the
    // way light drifts across a turned object. The ref attaches
    // to the <ChartSheenSweep> def; the hook imperatively pans
    // its gradientTransform. Distance = the donut diameter so the
    // band fully enters AND exits each pass.
    // prefers-reduced-motion → the loop never starts.
    const sheenRef = useChartSheen({
        distance: size,
        direction: 'horizontal',
    });

    // Loading takes precedence — shimmer in a same-size box keeps
    // layout stable while the data resolves.
    if (loading) {
        return (
            <div
                id={id}
                className={`flex flex-col items-center ${className}`}
                data-donut-loading
            >
                <div
                    className="rounded-full overflow-hidden"
                    style={{ width: size, height: size }}
                >
                    <ShimmerDots
                        rows={Math.max(4, Math.round(size / 16))}
                        cols={Math.max(4, Math.round(size / 16))}
                        className="h-full w-full"
                        aria-label={t('chartLoading')}
                    />
                </div>
            </div>
        );
    }

    const total = segments.reduce((sum, s) => sum + s.value, 0);
    const center = size / 2;
    // Reserve breathing room INSIDE the viewBox for the hover-pop, the
    // same way the MiniAreaChart bottom padding reserves room for the
    // curve overshoot (#753). On hover the active segment translates
    // radially outward by `CHART_HOVER_POP_DISTANCE` (4px); with the
    // old `(size-2)/2` radius the popped arc's outer edge landed
    // `size/2 + 3` from centre and got clipped at the SVG edge. Pull
    // the resting outer radius in by the pop distance (+1px stroke
    // buffer) so the popped edge stays just inside the viewBox.
    const outerRadius = size / 2 - CHART_HOVER_POP_DISTANCE - 1;
    const innerRadius = outerRadius - strokeWidth;

    // R16 hotfix (2026-05-13) — visx `<Pie>` + d3-shape's pie
    // generator misrenders when any segment has value === 0 and
    // padAngle > 0. The pad gets subtracted from each arc's
    // range; a zero-range arc goes NEGATIVE and renders as a
    // malformed path (or its neighbours stretch into the gap
    // and overpaint the visible segments).
    //
    // Concretely: dashboard with Critical=0 / High=1 / Medium=1 /
    // Low=1 rendered as a single thin orange crescent — Medium
    // and Low were SHADOWED out by the malformed Critical arc.
    //
    // The pre-R16 stroke-dasharray implementation handled this
    // by returning `null` for zero-value segments inside the
    // .map() callback. The R16 rebuild lost that filter when
    // we switched to feeding the whole `segments` array into
    // <Pie>. Re-introduce the filter by computing a separate
    // `pieSegments` array of only-non-zero entries; the legend
    // below still renders every entry (including zero ones)
    // because the legend is a separate concern from the chart
    // geometry.
    const pieSegments = segments.filter((s) => s.value > 0);

    // Empty state — same shape as pre-R16 but rendered via Pie
    // so the centring + sizing matches the populated case.
    if (total === 0) {
        return (
            <div id={id} className={`flex flex-col items-center ${className}`}>
                <svg
                    width={size}
                    height={size}
                    viewBox={`0 0 ${size} ${size}`}
                    role="img"
                    aria-label={t('noDataAvailable')}
                >
                    <circle
                        cx={center}
                        cy={center}
                        r={(innerRadius + outerRadius) / 2}
                        fill="none"
                        stroke="var(--bg-muted)"
                        strokeWidth={strokeWidth}
                        opacity={0.5}
                    />
                    <text
                        x={center}
                        y={center}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--content-muted)"
                        fontSize="14"
                        fontFamily="Inter, system-ui, sans-serif"
                    >
                        No data
                    </text>
                </svg>
            </div>
        );
    }

    // Stable list of unique series indices for the <defs> block.
    // A single donut may have multiple segments sharing a series
    // (e.g. open + reopened both styled as series-6), so we
    // deduplicate.
    const seriesInUse = Array.from(
        new Set(
            segments
                .map((s) => s.seriesIndex)
                .filter((v): v is ChartSeriesIndex => v !== undefined),
        ),
    );

    return (
        <div id={id} className={`flex flex-col items-center ${className}`}>
            <svg
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                role="img"
                aria-label={t('donutChartAria', {
                    segments: segments
                        .map((s) => `${s.label} ${s.value}`)
                        .join(', '),
                })}
            >
                <defs>
                    {seriesInUse.map((series) => (
                        <ChartRadialGradient
                            key={series}
                            id={chartGradientId(chartId, series, 'radial')}
                            series={series}
                            // Donut segments read best when the
                            // brighter start-stop concentrates
                            // toward the inner edge — the eye
                            // reads the band as "lit from within"
                            // rather than uniformly painted.
                            cx="50%"
                            cy="50%"
                            // Smaller radial radius pulls the
                            // colour transition tighter so the
                            // brighter start-stop is visible on
                            // a relatively narrow donut band.
                            r="65%"
                        />
                    ))}
                    {/* R16-PR6 — flow gradient for the hovered
                        segment. Only rendered when a segment with a
                        seriesIndex is currently hovered. The ref
                        attaches to the underlying <linearGradient>
                        so `useChartFlow` can imperatively animate
                        its `gradientTransform` attribute (the
                        "river of gradient colour" effect).
                        Conditional rendering keeps the defs block
                        small when no segment is hovered. */}
                    {flowSeries !== undefined && (
                        <ChartFlowGradient
                            id={chartGradientId(chartId, flowSeries, 'flow')}
                            series={flowSeries}
                            direction="horizontal"
                            ref={flowRef}
                        />
                    )}
                    {/* R18-PR4 — donut gloss sheen. ONE shared
                        gloss def for the whole donut: every segment
                        is on the same ring under the same light
                        source, so they all catch the same vertical
                        sheen. Each segment paints a second <path>
                        (same `d`) filled with this gloss on top of
                        its colour layer — the two-layer paint from
                        chart-gloss.tsx.

                        R18 visible-uplift — intensity `default →
                        bright`. The Risk Distribution donut is the
                        single most-looked-at chart on the executive
                        dashboard; the `default` 0.32-peak sheen was
                        too quiet to register at a glance. `bright`
                        (0.48 peak) makes the glass read
                        unmistakably without tipping into "shiny
                        plastic." */}
                    <ChartGloss
                        id={chartGlossId(chartId)}
                        direction="vertical"
                        intensity="bright"
                    />
                    {/* R18-PR10 — periodic sheen sweep def. The
                        ref attaches here so `useChartSheen` can
                        pan the gradientTransform. A narrow white
                        band travels horizontally across the donut
                        on a ~5s loop. */}
                    <ChartSheenSweep
                        ref={sheenRef}
                        id={chartSheenId(chartId)}
                        direction="horizontal"
                    />
                </defs>

                {/* Background ring — quiet bg-muted underneath the
                    segments so any small visual gaps read as
                    "missing data" rather than naked. */}
                <circle
                    cx={center}
                    cy={center}
                    r={(innerRadius + outerRadius) / 2}
                    fill="none"
                    stroke="var(--bg-muted)"
                    strokeWidth={strokeWidth}
                    opacity={0.35}
                />

                {/* Data segments — visx Pie produces real <path>
                    arc geometry with optional cornerRadius and
                    padAngle.

                    CENTRING — load-bearing `<g transform>`:
                    visx's `<Pie>` only applies its `top`/`left`
                    props in the DEFAULT render path. When a
                    `children` render-prop is supplied (as here),
                    visx returns `<>{children({arcs,path,pie})}</>`
                    and DROPS top/left entirely (see
                    node_modules/@visx/shape/lib/shapes/Pie.js:49).
                    d3-shape's arc generator emits coordinates
                    centred on the ORIGIN, so without an explicit
                    centring transform every arc renders around
                    SVG (0,0) — the top-left corner — and only the
                    sliver that pokes into the viewBox is visible.
                    The `translate(center,center)` group is what
                    moves the whole pie into the middle of the
                    viewBox. Do NOT pass top/left to <Pie> — they
                    are silently ignored in the children form and
                    only mislead the next reader.

                    R18-PR5 — bubble-entrance: the same group also
                    carries `scale(entranceProgress)`. On mount
                    `entranceProgress` springs 0 → ~1.05 → 1, so
                    the whole pie bubbles up from the centre. The
                    transform order is load-bearing: `translate`
                    THEN `scale`, so the scale pivots around the
                    donut centre (the translated origin), not the
                    SVG corner. SSR + reduced-motion → progress is
                    1, transform is `translate(c,c) scale(1)` =
                    identity-scaled, no entrance. */}
                <g
                    transform={`translate(${center},${center}) scale(${entranceProgress})`}
                >
                <Pie
                    data={pieSegments}
                    pieValue={(d: DonutSegment) => d.value}
                    outerRadius={outerRadius}
                    innerRadius={innerRadius}
                    // Subtle curved end-caps. Larger values
                    // make the slices look like bubbles; 1.5
                    // is the sweet spot for polished without
                    // distorting the proportional read.
                    cornerRadius={1.5}
                    // Tiny gap between segments. Avoids the
                    // colour bleed at boundaries while staying
                    // far short of "stamped wedges".
                    padAngle={0.012}
                >
                    {(pie) =>
                        pie.arcs.map((arc) => {
                            const seg = arc.data;
                            const isHovered = seg.label === hoveredKey;
                            // R16-PR6 — when this segment is the
                            // hovered one AND it has a seriesIndex,
                            // swap its fill from the resting radial
                            // gradient to the flow gradient (which
                            // useChartFlow animates via
                            // gradientTransform). Resting segments
                            // and segments without seriesIndex keep
                            // their previous fill behaviour.
                            const fill =
                                seg.seriesIndex === undefined
                                    ? seg.color
                                    : isHovered
                                      ? `url(#${chartGradientId(
                                            chartId,
                                            seg.seriesIndex,
                                            'flow',
                                        )})`
                                      : `url(#${chartGradientId(
                                            chartId,
                                            seg.seriesIndex,
                                            'radial',
                                        )})`;
                            const path = pie.path(arc);
                            // `== null` catches BOTH null and undefined —
                            // visx's arc generator returns `undefined` for a
                            // degenerate/zero-value segment, and the strict
                            // `=== null` form let it through, so the
                            // `<motion.path animate={{ d: undefined }}>`
                            // below set `d="undefined"` (the SVG console
                            // error seen across every donut surface).
                            if (path == null) return null;
                            const segPercent = seg.value / total;
                            // R16-PR6 — radial hover-pop. The mid-
                            // angle of the arc (in radians) drives
                            // the radial direction. visx uses the
                            // SVG convention where angles run from
                            // 12 o'clock clockwise. The pop hook
                            // expects "0 at 3 o'clock, positive
                            // clockwise" — subtract π/2 to convert.
                            const midAngle =
                                (arc.startAngle + arc.endAngle) / 2 -
                                Math.PI / 2;
                            const popTransform = pop.getDonutTransform(
                                seg.label,
                                midAngle,
                            );
                            return (
                                <g key={`${seg.label}-${arc.index}`}>
                                    {/* VISUAL layers — pop radially
                                        outward on hover, but INERT to
                                        the pointer (`pointer-events:
                                        none` on the group cascades to
                                        every child). The hover target
                                        is the stable hit path BELOW,
                                        not this group.

                                        Boundary-tremble fix: when the
                                        handlers lived on THIS popped
                                        group, hovering a segment near a
                                        boundary translated it 4px out
                                        from under the cursor →
                                        mouseleave → un-pop → the arc
                                        snapped back under the cursor →
                                        mouseenter → pop … an infinite
                                        oscillation (the "trembling"
                                        when the mouse sits between two
                                        sections). Decoupling the hit
                                        target from the moving geometry
                                        breaks the loop. */}
                                    <g
                                        transform={popTransform}
                                        pointerEvents="none"
                                        aria-hidden="true"
                                        style={{
                                            // R12 motion language —
                                            // transform via transition,
                                            // 200ms ease-out (matches
                                            // --chart-hover-duration).
                                            transition:
                                                'transform 200ms ease-out',
                                        }}
                                    >
                                        {/* Colour layer — the segment's
                                            series gradient (or legacy
                                            hex). R18-PR11 — motion.path
                                            morphs the `d` on data change;
                                            initial is false so the
                                            bubble-entrance owns the mount. */}
                                        <motion.path
                                            initial={false}
                                            animate={{ d: path }}
                                            transition={{
                                                duration: 0.5,
                                                ease: 'easeOut',
                                            }}
                                            fill={fill}
                                        />
                                        {/* R18-PR4 — gloss layer (same `d`,
                                            shared vertical gloss def). */}
                                        <motion.path
                                            initial={false}
                                            animate={{ d: path }}
                                            transition={{
                                                duration: 0.5,
                                                ease: 'easeOut',
                                            }}
                                            fill={`url(#${chartGlossId(chartId)})`}
                                        />
                                        {/* R18-PR10 — travelling sheen
                                            layer (same `d`). */}
                                        <motion.path
                                            initial={false}
                                            animate={{ d: path }}
                                            transition={{
                                                duration: 0.5,
                                                ease: 'easeOut',
                                            }}
                                            fill={`url(#${chartSheenId(chartId)})`}
                                        />
                                    </g>
                                    {/* STABLE hit target — the RESTING
                                        arc geometry, never translated, so
                                        it can't move out from under the
                                        cursor. Transparent fill +
                                        `pointer-events: all` makes the whole
                                        band hittable; this path owns the
                                        hover state, keyboard focus, a11y
                                        label, and native tooltip. */}
                                    <path
                                        d={path}
                                        fill="transparent"
                                        pointerEvents="all"
                                        onMouseEnter={() =>
                                            setHoveredKey(seg.label)
                                        }
                                        onMouseLeave={() => setHoveredKey(null)}
                                        onFocus={() => setHoveredKey(seg.label)}
                                        onBlur={() => setHoveredKey(null)}
                                        tabIndex={0}
                                        // Mouse convenience only — clicking the
                                        // slice navigates. It is deliberately NOT
                                        // an interactive ARIA role: making an SVG
                                        // arc a `role="link"` inside the chart's
                                        // `role="img"` trips axe `nested-interactive`.
                                        // The keyboard-accessible drill-through is
                                        // the legend row (`<DonutLegendRow>` → a
                                        // real <Link>), so this stays a plain
                                        // clickable image region.
                                        onClick={
                                            onSegmentClick && seg.href
                                                ? () => onSegmentClick(seg)
                                                : undefined
                                        }
                                        style={{
                                            outline: 'none',
                                            cursor: 'pointer',
                                        }}
                                        aria-label={`${seg.label}: ${seg.value}`}
                                    >
                                        <title>{`${seg.label}: ${seg.value} (${(segPercent * 100).toFixed(1)}%)`}</title>
                                    </path>
                                </g>
                            );
                        })
                    }
                </Pie>
                </g>

                {/* Center label */}
                {centerLabel && (
                    <text
                        x={center}
                        y={centerSub ? center - 6 : center}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--content-emphasis)"
                        fontSize="22"
                        fontWeight="700"
                        fontFamily="Inter, system-ui, sans-serif"
                    >
                        {centerLabel}
                    </text>
                )}
                {centerSub && (
                    <text
                        x={center}
                        y={center + 14}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="var(--content-muted)"
                        fontSize="11"
                        fontFamily="Inter, system-ui, sans-serif"
                    >
                        {centerSub}
                    </text>
                )}
            </svg>

            {/* Legend */}
            {showLegend && (
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-3">
                    {segments.map((seg) => {
                        // Legend swatches use the series START
                        // stop as a flat fill — the gradient
                        // layer is internal to the donut itself.
                        // Keeps the legend readable at chip size.
                        const swatch =
                            seg.seriesIndex !== undefined
                                ? `var(--chart-series-${seg.seriesIndex}-start)`
                                : seg.color;
                        return (
                            <div
                                key={seg.label}
                                className="flex items-center gap-1.5 text-xs text-content-muted"
                            >
                                <span
                                    className="w-2.5 h-2.5 rounded-full shrink-0"
                                    style={{ backgroundColor: swatch }}
                                />
                                <span>{seg.label}</span>
                                <span className="text-content-subtle tabular-nums">
                                    ({seg.value})
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
