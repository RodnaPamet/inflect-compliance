'use client';

/**
 * Cross-tier traceability Sankey (assets → risks → controls).
 *
 * 2026-05-30 — restored the pre-#536 visual design on user request:
 * the R21-PR-B rebuild had swapped the flat per-kind colours for
 * washed `<ChartLinearGradient>` fills + a swatch legend, which read
 * as lower-contrast and harder to scan. This version brings back the
 * flat, high-contrast look:
 *
 *   1. Each kind paints as ONE flat colour (`kindColor`) — still via
 *      the R16 `--chart-series-{N}-start` tokens, so it remains
 *      theme-aware (flips dark↔light), but solid rather than a
 *      gradient. No raw hex; no separate colour vocabulary.
 *
 *   2. A plain column header (kind label + node count + a small flat
 *      swatch) replaces the gradient `<ChartLegend>`.
 *
 *   3. Retained from PR-B (orthogonal to the colour revert): the
 *      hover-pop (highlighted links thicken + brighten, others dim),
 *      click-isolate (click a node to PIN the highlight, ESC/empty-
 *      canvas-click to unpin), and the inline `node.weight`
 *      annotation next to each label.
 *
 * The layout helper (`computeSankeyLayout`) is unchanged here — the
 * fit-to-content sizing + readability work lands in follow-up PRs.
 * No new dependencies (d3-sankey still rejected on bundle grounds).
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';
import Link from 'next/link';
import { cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { type ChartSeriesIndex } from '@/components/ui/charts';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import {
    type LaidOutLink,
    type LaidOutNode,
    type SankeyDataset,
    type SankeyNode,
    buildSankeyDataset,
    computeSankeyLayout,
    type SankeyLayout,
} from '@/lib/traceability-graph/sankey';
import type {
    TraceabilityCategory,
    TraceabilityGraph,
    TraceabilityNodeKind,
} from '@/lib/traceability-graph/types';

// ─── Public props ──────────────────────────────────────────────────────

export interface SankeyChartProps {
    graph: TraceabilityGraph;
    /** Search term — same one the explorer + table consume. */
    searchQuery?: string;
    id?: string;
    className?: string;
    /**
     * Canvas size override. The default uses an internal
     * `min-h` + responsive width via `viewBox`; override only when
     * the page layout demands a fixed size.
     */
    width?: number;
    height?: number;
}

// ─── Kind → chart-series index map ────────────────────────────────────
//
// Preserves the visual identity established in Epic 47.3 (amber-rose-
// cyan-emerald-violet) while routing through the R16 chart-series
// tokens. Dark + light theme tokens are paired per series — the
// Sankey now flips with the theme like every other chart.

const KIND_SERIES: Record<TraceabilityNodeKind, ChartSeriesIndex> = {
    asset: 6, // amber
    risk: 4, // pink (was rose)
    control: 2, // cyan (was sky)
    requirement: 5, // green (was emerald)
    policy: 3, // violet
};


// Flat per-kind fill. Restores the pre-#536 look: each kind reads as
// one distinct, high-contrast colour rather than a washed gradient.
// Implemented with the R16 chart-series tokens (the `-start` stop is
// the brighter hue) so it still flips dark↔light with the theme — no
// raw hex, no theme regression.
function kindColor(kind: TraceabilityNodeKind): string {
    return `var(--chart-series-${KIND_SERIES[kind]}-start)`;
}

// ─── Component ─────────────────────────────────────────────────────────

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 480;

export function SankeyChart({
    graph,
    searchQuery,
    id = 'sankey-chart',
    className,
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
}: SankeyChartProps) {
    const t = useTranslations('common.ui');
    const dataset = useMemo<SankeyDataset>(
        () => buildSankeyDataset(graph, { searchQuery }),
        [graph, searchQuery],
    );
    const layout = useMemo<SankeyLayout>(
        () => computeSankeyLayout(dataset, { width, height }),
        [dataset, width, height],
    );

    // Hover + pinned states. `activeId` is derived from the two —
    // hover takes precedence while the cursor is over a node; on
    // mouse-leave the pinned id (if any) wins.
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [pinnedId, setPinnedId] = useState<string | null>(null);
    const activeId = hoveredId ?? pinnedId;

    // Fit-to-view (zoom-out) toggle. Default OFF = the canvas renders
    // at full height and the container scrolls — every node is reachable
    // and reads at a legible size. ON = the whole diagram is scaled to
    // fit the viewport so you can see ALL controls/risks/assets at once
    // (smaller, overview). Combined with the fit-to-content layout
    // (`computeSankeyLayout` grows the height), nothing ever clips.
    const [fitToView, setFitToView] = useState(false);

    // ESC unpins for keyboard users. Routed through
    // `useKeyboardShortcut` (the canonical shared registry) instead
    // of a raw `window.addEventListener` — the project's
    // `keyboard-shortcut-conventions.test.ts` guardrail bans the
    // raw form so all shortcuts share the same focus/scope/inputs
    // safety net.
    useKeyboardShortcut(
        'Escape',
        () => {
            if (pinnedId) setPinnedId(null);
        },
        {
            description: t('shortcutUnpinNode'),
            enabled: pinnedId !== null,
        },
    );

    const onNodeClick = useCallback(
        (nodeId: string) => {
            setPinnedId((prev) => (prev === nodeId ? null : nodeId));
        },
        [],
    );

    // Empty / no-flow states get a clear message.
    if (dataset.nodes.length === 0) {
        return (
            <div
                id={id}
                data-sankey-chart="true"
                data-sankey-empty="true"
                className={cn(
                    cardVariants({ density: 'none' }),
                    'text-center py-10 text-content-subtle',
                    className,
                )}
            >
                {dataset.emptyAfterFilter
                    ? t('sankeyNoMatch', { query: (searchQuery ?? '').trim() })
                    : t('sankeyEmpty')}
            </div>
        );
    }
    if (dataset.links.length === 0) {
        return (
            <div
                id={id}
                data-sankey-chart="true"
                data-sankey-no-links="true"
                className={cn(
                    cardVariants({ density: 'none' }),
                    'text-center py-10 text-content-subtle',
                    className,
                )}
            >
                {t('sankeyNoLinks')}
            </div>
        );
    }

    // Below `md` the diagram's bars are a few pixels wide and its labels a
    // few pixels tall, so a phone gets the same flows as a list of links
    // instead (`<SankeyFlowList>`, built from THIS dataset). A CSS switch:
    // the server's paint is already right for the screen, and from `md` up
    // the chart renders exactly as before. The empty and no-link states
    // above are a sentence, which reads at any width, so they need no list.
    return (
        <>
            <SankeyFlowList dataset={dataset} chartId={id} className="md:hidden" />
            <div className="hidden md:block" data-testid="sankey-chart-desktop">
                <div
                    id={id}
                    data-sankey-chart="true"
                    data-sankey-node-count={layout.nodes.length}
                    data-sankey-link-count={layout.links.length}
                    data-sankey-pinned-id={pinnedId ?? undefined}
                    data-sankey-fit={fitToView ? 'true' : undefined}
                    className={cn(cardVariants({ density: 'none' }), 'px-2 py-2', className)}
                >
                    {/* Toolbar: zoom-out / fit-to-view toggle. */}
                    <div className="mb-2 flex items-center justify-between gap-compact px-2">
                        {/* Plain column header (restored pre-#536): each column's
                            kind label + node count, with a small flat colour swatch
                            matching the bars. Reads as a quiet caption, not a
                            separate colour vocabulary. */}
                        <div
                            data-sankey-legend="true"
                            className="grid flex-1 gap-tight"
                            style={{
                                gridTemplateColumns: `repeat(${layout.columns.length}, minmax(0, 1fr))`,
                            }}
                        >
                            {layout.columns.map((c) => (
                                <div
                                    key={c.kind}
                                    className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-content-subtle"
                                >
                                    <span
                                        aria-hidden
                                        className="inline-block size-2.5 shrink-0 rounded-[2px]"
                                        style={{ backgroundColor: kindColor(c.kind) }}
                                    />
                                    <span className="truncate">{t(`sankeyColumn.${c.kind}` as Parameters<typeof t>[0])}</span>
                                    <span className="text-content-muted tabular-nums">
                                        ({c.count})
                                    </span>
                                </div>
                            ))}
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            className="shrink-0"
                            onClick={() => setFitToView((v) => !v)}
                            id="sankey-fit-toggle"
                            aria-pressed={fitToView}
                        >
                            {fitToView ? t('sankeyActualSize') : t('sankeyFitToView')}
                        </Button>
                    </div>

                    {/* Scroll container — when the canvas grows past the
                        viewport (many nodes) you scroll to reach them; in
                        fit-to-view mode the SVG is scaled to fit instead. */}
                    <div
                        data-sankey-scroll="true"
                        className="overflow-auto"
                        // `scrollbar-gutter: stable` reserves the scrollbar's
                        // track so it never overlays the right-hand (control)
                        // column when the canvas is taller than the viewport.
                        style={{ maxHeight: '76vh', scrollbarGutter: 'stable' }}
                    >
                        <svg
                            role="img"
                            aria-label={t('sankeyFlow')}
                            viewBox={`0 0 ${layout.width} ${layout.height}`}
                            preserveAspectRatio="xMidYMid meet"
                            className={fitToView ? 'mx-auto block' : 'w-full'}
                            style={
                                fitToView
                                    ? { height: '72vh', maxWidth: '100%' }
                                    : { minHeight: 320 }
                            }
                            onClick={(e) => {
                                // Click on empty SVG canvas (not a node) unpins.
                                if (e.target === e.currentTarget && pinnedId) {
                                    setPinnedId(null);
                                }
                            }}
                        >
                        {/* Links painted first so node bars sit on top. */}
                        <g data-sankey-layer="links">
                            {layout.links.map((link) => (
                                <SankeyLinkPath
                                    key={link.id}
                                    link={link}
                                    isHighlighted={
                                        activeId !== null &&
                                        (activeId === link.source ||
                                            activeId === link.target)
                                    }
                                    isDimmed={
                                        activeId !== null &&
                                        activeId !== link.source &&
                                        activeId !== link.target
                                    }
                                />
                            ))}
                        </g>
                        <g data-sankey-layer="nodes">
                            {layout.nodes.map((node) => (
                                <SankeyNodeRect
                                    key={node.id}
                                    node={node}
                                    highlighted={activeId === node.id}
                                    pinned={pinnedId === node.id}
                                    onHover={() => setHoveredId(node.id)}
                                    onLeave={() => setHoveredId(null)}
                                    onClick={() => onNodeClick(node.id)}
                                />
                            ))}
                        </g>
                    </svg>
                    </div>
                </div>
            </div>
        </>
    );
}

// ─── Phone list ────────────────────────────────────────────────────────
//
// The Sankey's flows as a list — what `<SankeyChart>` shows below `md`.
//
// On a phone the diagram's labels shrink to a few pixels and its node bars
// to a few pixels of tap target, so the chart renders this instead: a notice
// that the diagram is drawn for a larger screen (owner decision, 2026-11-23:
// "notice plus a summary list" for desktop-shaped surfaces), then every flow
// the diagram draws, band by band (Assets → Risks, Risks → Controls,
// Controls → Requirements). Within a band the flows are grouped by their
// source, and each source and target links to its own page, in a 44px row.
//
// It is built from the chart's own dataset (the same search applied), so the
// two cannot disagree about which flows exist: a link the chart draws is a
// row here, and two edges between the same pair are one row with a count. It
// lived on the controls flow page (#5908) until the chart took it over, so
// that no page can put the diagram on a phone without it. It lives in this
// file because this file is already the domain-coupled one
// (docs/_status/ui-core-classification.json).

export interface SankeyFlowBand {
    key: string;
    sourceKind: TraceabilityNodeKind;
    targetKind: TraceabilityNodeKind;
    /** Every flow in the band, counted per edge (the chart's link count). */
    flowCount: number;
    sources: Array<{
        node: SankeyNode;
        targets: Array<{ node: SankeyNode; count: number }>;
    }>;
}

/**
 * Groups the dataset's links by band, then by source, then by target.
 * Bands follow the chart's column order; sources and targets keep the
 * order the chart stacks them in.
 */
export function sankeyFlowBands(dataset: SankeyDataset): SankeyFlowBand[] {
    const nodeById = new Map(dataset.nodes.map((n) => [n.id, n]));
    const order = new Map(dataset.nodes.map((n, i) => [n.id, i]));
    const bands = new Map<string, SankeyFlowBand & { bySource: Map<string, Map<string, number>> }>();

    for (const link of dataset.links) {
        const src = nodeById.get(link.source);
        const tgt = nodeById.get(link.target);
        if (!src || !tgt) continue;
        const key = `${src.columnIndex}-${tgt.columnIndex}`;
        let band = bands.get(key);
        if (!band) {
            band = { key, sourceKind: src.kind, targetKind: tgt.kind, flowCount: 0, sources: [], bySource: new Map() };
            bands.set(key, band);
        }
        band.flowCount += link.value;
        const targets = band.bySource.get(src.id) ?? new Map<string, number>();
        targets.set(tgt.id, (targets.get(tgt.id) ?? 0) + link.value);
        band.bySource.set(src.id, targets);
    }

    const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
    return [...bands.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ bySource, ...band }) => ({
            ...band,
            sources: [...bySource.keys()].sort(byOrder).map((sourceId) => {
                const targets = bySource.get(sourceId)!;
                return {
                    node: nodeById.get(sourceId)!,
                    targets: [...targets.keys()].sort(byOrder).map((targetId) => ({
                        node: nodeById.get(targetId)!,
                        count: targets.get(targetId)!,
                    })),
                };
            }),
        }));
}

/** A node's name, as a link to its page when it has one. */
function NodeLink({ node, className }: { node: SankeyNode; className?: string }) {
    const body = <span className="min-w-0 break-words">{node.label}</span>;
    const base = cn('flex min-h-11 items-center', className);
    return node.href ? (
        <Link href={node.href} className={cn(base, 'hover:underline')}>
            {body}
        </Link>
    ) : (
        <span className={base}>{body}</span>
    );
}

export interface SankeyFlowListProps {
    /** The dataset the chart draws — never a second projection of the graph. */
    dataset: SankeyDataset;
    /** The chart's id; the list's own ids derive from it. */
    chartId: string;
    className?: string;
}

export function SankeyFlowList({ dataset, chartId, className }: SankeyFlowListProps) {
    const t = useTranslations('common.ui');
    const bands = useMemo(() => sankeyFlowBands(dataset), [dataset]);
    const kindLabel = (kind: TraceabilityNodeKind) => t(`sankeyColumn.${kind}` as Parameters<typeof t>[0]);

    return (
        <div className={cn('space-y-default', className)} id={`${chartId}-flows`} data-testid="sankey-flow-summary">
            <InlineNotice variant="info" id={`${chartId}-larger-screen`}>
                {t('sankeyPhone.notice')}
            </InlineNotice>
            {bands.map((band) => {
                const heading = `${kindLabel(band.sourceKind)} → ${kindLabel(band.targetKind)}`;
                return (
                    <section
                        key={band.key}
                        className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}
                        aria-label={heading}
                        data-sankey-band={`${band.sourceKind}-${band.targetKind}`}
                    >
                        <div className="flex flex-wrap items-baseline justify-between gap-tight">
                            <Heading level={2}>{heading}</Heading>
                            <span className="text-xs text-content-muted tabular-nums">
                                {t('sankeyPhone.flowCount', { count: band.flowCount })}
                            </span>
                        </div>
                        <ul className="divide-y divide-border-subtle">
                            {band.sources.map(({ node, targets }) => (
                                <li key={node.id} className="py-tight" data-sankey-source={node.id}>
                                    <NodeLink node={node} className="text-sm font-medium text-content-emphasis" />
                                    <ul
                                        className="border-l border-border-subtle pl-3"
                                        aria-label={t('sankeyPhone.targetsAria', { name: node.label })}
                                    >
                                        {targets.map(({ node: target, count }) => (
                                            <li
                                                key={target.id}
                                                className="flex items-center gap-tight text-sm text-content-default"
                                                data-sankey-flow={`${node.id}->${target.id}`}
                                            >
                                                <span aria-hidden className="text-content-subtle">→</span>
                                                <NodeLink node={target} className="flex-1" />
                                                {count > 1 && (
                                                    <span className="shrink-0 text-xs text-content-muted tabular-nums">
                                                        ×{count}
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}

// ─── Sub-components ────────────────────────────────────────────────────

function SankeyLinkPath({
    link,
    isHighlighted,
    isDimmed,
}: {
    link: LaidOutLink;
    isHighlighted: boolean;
    isDimmed: boolean;
}) {
    const t = useTranslations('common.ui');
    const relationLabel = t(`sankeyRelation.${link.relation}` as Parameters<typeof t>[0]);
    // Hover-pop: highlighted links thicken slightly + lift to higher
    // opacity; dimmed links drop to 0.05. Flat per-kind stroke colour
    // (the source tier's colour) rather than a gradient.
    const strokeWidth = isHighlighted ? link.strokeWidth * 1.5 : link.strokeWidth;
    const opacity = isDimmed ? 0.05 : isHighlighted ? 0.7 : 0.3;
    return (
        <path
            d={link.pathD}
            data-sankey-link-id={link.id}
            data-sankey-relation={link.relation}
            stroke={kindColor(link.sourceKind)}
            strokeWidth={strokeWidth}
            fill="none"
            opacity={opacity}
            style={{
                transition:
                    'opacity 150ms ease-out, stroke-width 150ms ease-out',
            }}
        >
            <title>
                {t('sankeyLinkTitle', { relation: relationLabel, value: link.value })}
            </title>
        </path>
    );
}

function SankeyNodeRect({
    node,
    highlighted,
    pinned,
    onHover,
    onLeave,
    onClick,
}: {
    node: LaidOutNode;
    highlighted: boolean;
    pinned: boolean;
    onHover: () => void;
    onLeave: () => void;
    onClick: () => void;
}) {
    const t = useTranslations('common.ui');
    const labelOnRight = node.x > 0;
    const opacity = highlighted ? 1 : 0.85;
    const rect = (
        <rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            fill={kindColor(node.kind)}
            opacity={opacity}
            rx={2}
            // R21-PR-B: pinned ring + label-side weight annotation.
            // The ring sits just outside the bar; rx matches so the
            // ring tracks the rounded corners.
            style={{
                transition: 'opacity 150ms ease-out',
                outline: pinned ? '1px solid var(--brand-default)' : undefined,
                outlineOffset: 1,
            }}
        >
            <title>
                {t('sankeyNodeTitle', { label: node.label, weight: node.weight })}
            </title>
        </rect>
    );
    return (
        <g
            data-sankey-node-id={node.id}
            data-sankey-node-kind={node.kind}
            data-sankey-node-pinned={pinned ? 'true' : undefined}
            onMouseEnter={onHover}
            onMouseLeave={onLeave}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            style={{ cursor: node.href ? 'pointer' : 'default' }}
        >
            {node.href ? <Link href={node.href}>{rect}</Link> : rect}
            {/* Name + count in ONE text run so the count is laid out by
                the browser after the name with a fixed `dx` gap — they
                can never collide (the old hand-computed offset did).
                12px brighter name + 11px tabular-nums count; both tint
                when the node is active. */}
            <text
                x={labelOnRight ? node.x - 6 : node.x + node.width + 6}
                y={node.y + node.height / 2}
                dy="0.32em"
                textAnchor={labelOnRight ? 'end' : 'start'}
                className={cn(
                    'fill-content-default',
                    highlighted && 'fill-content-emphasis font-semibold',
                )}
                fontSize={12}
                pointerEvents="none"
            >
                {truncate(node.label, 28)}
                <tspan
                    dx={8}
                    className={cn(
                        'fill-content-muted font-mono tabular-nums',
                        highlighted && 'fill-[var(--brand-default)]',
                    )}
                    fontSize={11}
                >
                    {node.weight}
                </tspan>
            </text>
        </g>
    );
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/**
 * Re-export so callers that want one import path can pull the
 * dataset-shape type from the component module too.
 */
export type { SankeyDataset } from '@/lib/traceability-graph/sankey';
export type { TraceabilityCategory };
