'use client';

/**
 * RQ3-5 — ALE histogram primitive ("from heatmaps to histograms").
 *
 * The third register view of the risk portfolio: each quantified
 * risk lands in a log-x decade bucket (€1K–€10K, €10K–€100K, …),
 * bars stack by the risk's tenant matrix band (the same colours the
 * heatmap paints), and the per-risk appetite cap draws as a dashed
 * vertical line — genuinely honest here, because the x-axis IS
 * per-risk ALE.
 *
 * Shape vocabulary borrowed from the LossExceedanceCurve primitive:
 * visx scales + token-backed chrome, no animation, no hover
 * crosshair. A11y: the svg carries a generated plain-language
 * summary, and every bucket is a focusable group whose aria-label
 * reads its range + per-band counts (keyboard users tab through the
 * distribution).
 */
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { ParentSize } from '@visx/responsive';
import { Group } from '@visx/group';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { scaleLinear } from '@visx/scale';
import { formatCompactCurrency } from '@/lib/risk-coherence';

export interface AleHistogramDatum {
    id: string;
    title: string;
    /** Resolved ALE (must be > 0 — caller filters). */
    ale: number;
    /** Tenant matrix band of the risk's score (drives the stack colour). */
    bandName: string;
    bandColor: string;
}

export interface AleHistogramProps {
    data: ReadonlyArray<AleHistogramDatum>;
    /** Per-risk appetite cap — drawn as a dashed vertical line. */
    referenceLine?: { value: number; label: string } | null;
    height?: number;
    ariaLabel?: string;
    className?: string;
    testId?: string;
    /** Tenant-currency formatter (one voice — OB-A). */
    formatMoney?: (v: number | null | undefined) => string;
}

const DEFAULT_HEIGHT = 240;
const MARGIN = { top: 16, right: 24, bottom: 32, left: 36 };

interface Bucket {
    /** Decade exponent: bucket spans [10^exp, 10^(exp+1)). */
    exp: number;
    lo: number;
    hi: number;
    total: number;
    /** band name → { color, count } in stack order (largest first). */
    segments: Array<{ bandName: string; color: string; count: number }>;
}

/** Decade-bucket the data. Pure — exported for unit coverage. */
export function bucketByDecade(data: ReadonlyArray<AleHistogramDatum>): Bucket[] {
    if (data.length === 0) return [];
    const byExp = new Map<number, Map<string, { color: string; count: number }>>();
    for (const d of data) {
        if (!(d.ale > 0)) continue;
        const exp = Math.floor(Math.log10(d.ale));
        const bands = byExp.get(exp) ?? new Map();
        const seg = bands.get(d.bandName) ?? { color: d.bandColor, count: 0 };
        seg.count += 1;
        bands.set(d.bandName, seg);
        byExp.set(exp, bands);
    }
    if (byExp.size === 0) return [];
    const exps = [...byExp.keys()];
    const minExp = Math.min(...exps);
    const maxExp = Math.max(...exps);
    const buckets: Bucket[] = [];
    for (let exp = minExp; exp <= maxExp; exp++) {
        const bands = byExp.get(exp) ?? new Map<string, { color: string; count: number }>();
        const segments = [...bands.entries()]
            .map(([bandName, s]) => ({ bandName, color: s.color, count: s.count }))
            .sort((a, b) => b.count - a.count);
        buckets.push({
            exp,
            lo: 10 ** exp,
            hi: 10 ** (exp + 1),
            total: segments.reduce((s, x) => s + x.count, 0),
            segments,
        });
    }
    return buckets;
}

function AleHistogramInner({
    data,
    width,
    height,
    referenceLine,
    ariaLabel,
    testId,
    className,
    formatMoney = (v) => formatCompactCurrency(v),
}: AleHistogramProps & { width: number; height: number }) {
    const t = useTranslations('common.chart');
    const buckets = useMemo(() => bucketByDecade(data), [data]);

    const xMax = Math.max(0, width - MARGIN.left - MARGIN.right);
    const yMax = Math.max(0, height - MARGIN.top - MARGIN.bottom);

    // Log-x via exponents on a LINEAR scale — each decade gets equal
    // width, and the appetite line lands at its exact log position.
    // The domain stretches to keep an out-of-range cap on canvas.
    const loExp = buckets.length ? buckets[0].exp : 0;
    const hiExp = buckets.length ? buckets[buckets.length - 1].exp + 1 : 1;
    const refExp = referenceLine && referenceLine.value > 0 ? Math.log10(referenceLine.value) : null;
    const domain: [number, number] = [
        Math.min(loExp, refExp != null ? Math.floor(refExp) : loExp),
        Math.max(hiExp, refExp != null ? Math.ceil(refExp) : hiExp),
    ];
    const xScale = useMemo(
        () => scaleLinear<number>({ range: [0, xMax], domain }),
        [xMax, domain[0], domain[1]], // eslint-disable-line react-hooks/exhaustive-deps
    );
    const maxCount = buckets.reduce((m, b) => Math.max(m, b.total), 0);
    const yScale = useMemo(
        () => scaleLinear<number>({ range: [yMax, 0], domain: [0, Math.max(1, maxCount)], nice: true }),
        [yMax, maxCount],
    );

    if (buckets.length === 0 || width === 0 || height === 0) return null;

    const tallest = buckets.reduce((m, b) => (b.total > m.total ? b : m), buckets[0]);
    const summary =
        `ALE histogram: ${data.length} quantified risks across ${buckets.filter((b) => b.total > 0).length} ` +
        `loss buckets from ${formatMoney(buckets[0].lo)} to ${formatMoney(buckets[buckets.length - 1].hi)}; ` +
        `tallest bucket ${formatMoney(tallest.lo)}–${formatMoney(tallest.hi)} with ${tallest.total} risks` +
        (referenceLine ? `; ${referenceLine.label} at ${formatMoney(referenceLine.value)}` : '');

    return (
        <svg
            width={width}
            height={height}
            role="img"
            aria-label={ariaLabel ?? summary}
            data-testid={testId ?? 'ale-histogram'}
            className={className}
        >
            <Group left={MARGIN.left} top={MARGIN.top}>
                <g role="list" aria-label={t('lossBucketsAria')}>
                {buckets.map((b) => {
                    const x0 = xScale(b.exp) ?? 0;
                    const x1 = xScale(b.exp + 1) ?? 0;
                    const barWidth = Math.max(0, x1 - x0 - 2);
                    let yCursor = yMax;
                    const label =
                        `${formatMoney(b.lo)}–${formatMoney(b.hi)}: ${b.total} risk${b.total === 1 ? '' : 's'}` +
                        (b.segments.length
                            ? ` (${b.segments.map((s) => `${s.count} ${s.bandName}`).join(', ')})`
                            : '');
                    return (
                        <g
                            key={b.exp}
                            tabIndex={b.total > 0 ? 0 : -1}
                            role="listitem"
                            aria-label={label}
                            data-testid={`ale-histogram-bucket-${b.exp}`}
                            data-count={b.total}
                            className="focus:outline-none focus-visible:opacity-80"
                        >
                            {b.segments.map((s) => {
                                const h = yMax - (yScale(s.count) ?? 0);
                                yCursor -= h;
                                return (
                                    <rect
                                        key={s.bandName}
                                        x={x0 + 1}
                                        y={yCursor}
                                        width={barWidth}
                                        height={h}
                                        fill={s.color}
                                        fillOpacity={0.85}
                                        data-band={s.bandName}
                                    />
                                );
                            })}
                        </g>
                    );
                })}
                </g>
                {referenceLine && refExp != null && (
                    <g data-testid="ale-histogram-reference-line">
                        <line
                            x1={xScale(refExp) ?? 0}
                            x2={xScale(refExp) ?? 0}
                            y1={0}
                            y2={yMax}
                            stroke="var(--content-error, #ef4444)"
                            strokeWidth={1.5}
                            strokeDasharray="4 3"
                            strokeOpacity={0.85}
                        />
                        <text
                            x={xScale(refExp) ?? 0}
                            y={-4}
                            fontSize={9}
                            textAnchor="middle"
                            fill="var(--content-error, #ef4444)"
                        >
                            {referenceLine.label} ({formatMoney(referenceLine.value)})
                        </text>
                    </g>
                )}
                <AxisBottom
                    top={yMax}
                    scale={xScale}
                    tickValues={Array.from({ length: domain[1] - domain[0] + 1 }, (_, i) => domain[0] + i)}
                    tickFormat={(v) => formatMoney(10 ** Number(v))}
                    tickStroke="var(--content-subtle, #94a3b8)"
                    stroke="var(--content-subtle, #94a3b8)"
                    tickLabelProps={() => ({
                        fill: 'var(--content-muted, #64748b)',
                        fontSize: 10,
                        textAnchor: 'middle',
                    })}
                />
                <AxisLeft
                    scale={yScale}
                    numTicks={4}
                    tickFormat={(v) => `${v}`}
                    tickStroke="var(--content-subtle, #94a3b8)"
                    stroke="var(--content-subtle, #94a3b8)"
                    tickLabelProps={() => ({
                        fill: 'var(--content-muted, #64748b)',
                        fontSize: 10,
                        textAnchor: 'end',
                        dx: -4,
                        dy: 3,
                    })}
                />
            </Group>
        </svg>
    );
}

export function AleHistogram(props: AleHistogramProps) {
    const explicitHeight = props.height ?? DEFAULT_HEIGHT;
    return (
        <div
            data-testid={`${props.testId ?? 'ale-histogram'}-wrapper`}
            className={props.className}
            style={{ width: '100%', height: explicitHeight }}
        >
            <ParentSize>
                {({ width }) => (
                    <AleHistogramInner {...props} width={width} height={explicitHeight} />
                )}
            </ParentSize>
        </div>
    );
}
