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
import { cn } from '@inflect/ui/lib/cn';
import Link from 'next/link';
import { cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { type ChartSeriesIndex } from '@/components/ui/charts';
import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';
import {
    type LaidOutLink,
    type LaidOutNode,
    type SankeyDataset,
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
            description: 'Unpin Sankey node',
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
                    ? `No flows match "${(searchQuery ?? '').trim()}"`
                    : 'No mapping flows to display.'}
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
                Nodes are present but no cross-tier mapping flows have been recorded yet.
            </div>
        );
    }

    return (
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
                            className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-content-subtle"
                        >
                            <span
                                aria-hidden
                                className="inline-block size-2.5 shrink-0 rounded-[2px]"
                                style={{ backgroundColor: kindColor(c.kind) }}
                            />
                            <span className="truncate">{c.label}</span>
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
                    {fitToView ? 'Actual size' : 'Fit to view'}
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
                    aria-label="Cross-tier traceability flow (Sankey)"
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
                {link.relation} ({link.value})
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
                {node.label} (weight {node.weight})
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
