'use client';

/**
 * Epic 47.1 — Generic graph-explorer wrapper around React Flow.
 *
 * Decoupled from any specific data source: takes typed graph
 * payload (`nodes`, `edges`, `categories`) — see
 * `@/lib/traceability-graph/types` — and renders an interactive
 * canvas with sensible defaults for medium-sized graphs.
 *
 * Reusable beyond traceability — any caller with a payload that
 * structurally satisfies `GraphExplorerProps` (a typed-node /
 * typed-edge graph + category metadata) can mount this directly.
 *
 * Design choices:
 *
 *   - **Stable per-kind palette** sourced from the payload's
 *     `categories` list. Adding a new node kind on the server is a
 *     one-line change and the explorer paints it correctly without
 *     a code change here.
 *
 *   - **fitView on first paint**, no layout algorithm — for the
 *     MVP we use React Flow's `Layout.Default` (positional based
 *     on caller-supplied coordinates) but seed coordinates via a
 *     deterministic radial layout if none are supplied. A future
 *     phase can swap in dagre / elk without changing the public
 *     contract.
 *
 *   - **Controls + MiniMap + Background** mounted by default.
 *     Reasonable defaults are the entire point of the wrapper.
 *
 *   - **Selection callback**: `onNodeSelected(node)` fires on click;
 *     the parent decides what to do (open detail panel, navigate
 *     via the node's `href`, etc.).
 *
 *   - **Bundle**: React Flow is ~150KB minified. Pages that mount
 *     this component should use
 *     `next/dynamic({ ssr: false })` so the chunk doesn't land on
 *     pages that don't need it. The component itself is `'use
 *     client'` so it never SSRs.
 */

import { cn } from '@inflect/ui/lib/cn';
import { cardVariants } from '@/components/ui/card';
import {
    Background,
    Controls,
    MiniMap,
    ReactFlow,
    type Edge,
    type Node,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
    AlertTriangle,
    Box,
    FileText,
    ScrollText,
    ShieldCheck,
    type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { memo, useCallback, useMemo } from 'react';
import {
    computeSearchHighlight,
    isEdgeDimmed,
} from '@/lib/traceability-graph/search';
import type {
    TraceabilityCategory,
    TraceabilityEdge,
    TraceabilityGraph,
    TraceabilityNode,
} from '@/lib/traceability-graph/types';

// ─── Public props ──────────────────────────────────────────────────────

export interface GraphExplorerProps {
    /** The typed graph payload from the API. */
    graph: TraceabilityGraph;
    /** Called when the user clicks a node in the canvas. */
    onNodeSelected?: (node: TraceabilityNode) => void;
    /** Optional id on the wrapper for tests/analytics. */
    id?: string;
    className?: string;
    /**
     * When true (default), nodes render as clickable links to
     * their `href`. When false, the explorer relies on
     * `onNodeSelected` only.
     */
    nodeAsLinks?: boolean;
    /**
     * Live search query. Pulled into a controlled prop so the
     * parent (the traceability page) owns input state and can
     * preserve it across the graph/table view toggle. Empty /
     * whitespace-only string disables search dimming.
     */
    searchQuery?: string;
}

// ─── Color tokens ──────────────────────────────────────────────────────

/**
 * Map the abstract palette name from the payload to concrete
 * CSS classes / hex values. One source of truth — tweaks land
 * here, every node respects them.
 */
const COLOR_MAP: Record<TraceabilityCategory['color'], { fg: string; bg: string; border: string; minimap: string }> = {
    sky: { fg: 'text-sky-300', bg: 'bg-sky-500/10', border: 'border-sky-400/60', minimap: '#7dd3fc' },
    rose: { fg: 'text-rose-300', bg: 'bg-rose-500/10', border: 'border-rose-400/60', minimap: '#fda4af' },
    emerald: { fg: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-400/60', minimap: '#6ee7b7' },
    violet: { fg: 'text-violet-300', bg: 'bg-violet-500/10', border: 'border-violet-400/60', minimap: '#c4b5fd' },
    amber: { fg: 'text-amber-300', bg: 'bg-amber-500/10', border: 'border-amber-400/60', minimap: '#fcd34d' },
    slate: { fg: 'text-slate-300', bg: 'bg-slate-500/10', border: 'border-slate-400/60', minimap: '#94a3b8' },
};

// ─── Icon + pattern maps (non-color cues for color-blind users) ────────

/**
 * Icon glyph per kind — second cue alongside colour. A colour-
 * blind user can still tell a `Control` (shield) from a `Risk`
 * (warning triangle) from an `Asset` (box) without seeing the
 * palette.
 */
const ICON_MAP: Record<TraceabilityCategory['iconKey'], LucideIcon> = {
    'shield-check': ShieldCheck,
    'alert-triangle': AlertTriangle,
    'box': Box,
    'file-text': FileText,
    'scroll-text': ScrollText,
};

/**
 * Border-pattern utility per kind — third cue. Combined with
 * colour + icon this means even a fully-monochrome render still
 * carries the kind distinction.
 */
const PATTERN_MAP: Record<TraceabilityCategory['pattern'], string> = {
    solid: 'border-solid',
    dashed: 'border-dashed',
    double: 'border-double border-4',
};

// ─── Layout (deterministic radial fallback) ────────────────────────────

/**
 * Seed initial node positions when the payload doesn't include
 * any. Groups nodes by `kind` and lays each group out in a
 * concentric ring around the canvas centre. Deterministic — same
 * input always produces the same coords, so React Flow doesn't
 * jitter rows on re-render.
 *
 * Replace with dagre / elk in a phase-2 enhancement; the call
 * signature here is stable so the swap is local.
 */
function radialPositions(
    nodes: ReadonlyArray<TraceabilityNode>,
): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    if (nodes.length === 0) return out;
    const byKind = new Map<TraceabilityNode['kind'], TraceabilityNode[]>();
    for (const n of nodes) {
        const list = byKind.get(n.kind) ?? [];
        list.push(n);
        byKind.set(n.kind, list);
    }

    const kinds = [...byKind.keys()];
    const ringStep = 220; // px between concentric rings
    const center = { x: 0, y: 0 };

    kinds.forEach((kind, kindIdx) => {
        const list = byKind.get(kind)!;
        const radius = ringStep * (kindIdx + 1);
        const N = list.length;
        list.forEach((node, i) => {
            const angle = (2 * Math.PI * i) / Math.max(N, 1);
            out.set(node.id, {
                x: center.x + radius * Math.cos(angle),
                y: center.y + radius * Math.sin(angle),
            });
        });
    });
    return out;
}

// ─── React Flow adapter ────────────────────────────────────────────────

// React Flow's `Node<TData>` requires `TData extends Record<string,
// unknown>` so its internal serialisation is structurally
// compatible with arbitrary JSON. Indexer signature makes this
// satisfy the constraint without giving up named-field typing on
// the access side.
interface NodeData extends Record<string, unknown> {
    label: string;
    secondary: string | null;
    badge: string | null;
    href: string | null;
    kind: TraceabilityNode['kind'];
    color: TraceabilityCategory['color'];
    iconKey: TraceabilityCategory['iconKey'];
    pattern: TraceabilityCategory['pattern'];
    nodeAsLink: boolean;
    onClickPayload: TraceabilityNode;
    /** 'matched' | 'adjacent' | 'dimmed' | 'normal' */
    highlightTier: 'matched' | 'adjacent' | 'dimmed' | 'normal';
}

const TraceNode = memo(function TraceNode({
    data,
}: {
    data: NodeData;
}) {
    const palette = COLOR_MAP[data.color];
    const Icon = ICON_MAP[data.iconKey];
    const patternCls = PATTERN_MAP[data.pattern];
    const dimmed = data.highlightTier === 'dimmed';
    const matched = data.highlightTier === 'matched';
    const inner = (
        <div
            data-trace-node-kind={data.kind}
            data-highlight-tier={data.highlightTier}
            className={cn(
                'min-w-[140px] max-w-[200px] rounded-md px-2.5 py-1.5 shadow-sm transition-opacity',
                'text-xs border-2',
                patternCls,
                palette.bg,
                palette.border,
                dimmed && 'opacity-25',
                matched && 'ring-2 ring-offset-2 ring-offset-bg-default ring-yellow-300',
            )}
        >
            <div className={cn('flex items-center gap-1.5 font-semibold', palette.fg)}>
                <Icon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{data.label}</span>
            </div>
            {data.secondary && (
                <div className="text-[10px] text-content-muted truncate mt-0.5">
                    {data.secondary}
                </div>
            )}
            {data.badge && (
                <div className="text-[10px] text-content-subtle mt-1 truncate">
                    {data.badge}
                </div>
            )}
        </div>
    );

    if (data.nodeAsLink && data.href) {
        return (
            <Link
                href={data.href}
                className="no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] rounded-md"
                onClick={(e) => e.stopPropagation()}
            >
                {inner}
            </Link>
        );
    }
    return inner;
});

const NODE_TYPES: NodeTypes = { trace: TraceNode };

function adaptNodes(
    graph: TraceabilityGraph,
    nodeAsLinks: boolean,
    highlight: ReturnType<typeof computeSearchHighlight>,
): Node<NodeData>[] {
    const positions = radialPositions(graph.nodes);
    const visualByKind = new Map(graph.categories.map((c) => [c.kind, c]));
    return graph.nodes.map((n) => {
        const pos = positions.get(n.id) ?? { x: 0, y: 0 };
        const cat = visualByKind.get(n.kind);
        const tier: NodeData['highlightTier'] = !highlight.hasQuery
            ? 'normal'
            : highlight.matched.has(n.id)
              ? 'matched'
              : highlight.adjacent.has(n.id)
                ? 'adjacent'
                : 'dimmed';
        return {
            id: n.id,
            type: 'trace',
            position: pos,
            data: {
                label: n.label,
                secondary: n.secondary,
                badge: n.badge,
                href: n.href,
                kind: n.kind,
                color: cat?.color ?? 'slate',
                iconKey: cat?.iconKey ?? 'box',
                pattern: cat?.pattern ?? 'solid',
                nodeAsLink: nodeAsLinks,
                onClickPayload: n,
                highlightTier: tier,
            },
        };
    });
}

function adaptEdges(
    graph: TraceabilityGraph,
    dimmedNodeIds: ReadonlySet<string>,
): Edge[] {
    return graph.edges.map((e: TraceabilityEdge) => {
        const dim = isEdgeDimmed(e, dimmedNodeIds);
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            // Keep the edge style minimal — React Flow defaults read
            // well; we only annotate semantics via the `label`
            // attribute when there's a useful qualifier.
            label: e.qualifier ?? undefined,
            labelStyle: { fontSize: 10, fill: 'rgb(148 163 184)' },
            style: dim ? { opacity: 0.15 } : undefined,
            data: { relation: e.relation, qualifier: e.qualifier },
        };
    });
}

// ─── Component ─────────────────────────────────────────────────────────

export function GraphExplorer({
    graph,
    onNodeSelected,
    id = 'graph-explorer',
    className,
    nodeAsLinks = true,
    searchQuery = '',
}: GraphExplorerProps) {
    const highlight = useMemo(
        () => computeSearchHighlight(graph.nodes, graph.edges, searchQuery),
        [graph.nodes, graph.edges, searchQuery],
    );
    const rfNodes = useMemo(
        () => adaptNodes(graph, nodeAsLinks, highlight),
        [graph, nodeAsLinks, highlight],
    );
    const rfEdges = useMemo(
        () => adaptEdges(graph, highlight.dimmed),
        [graph, highlight.dimmed],
    );

    const handleNodeClick = useCallback(
        (_e: React.MouseEvent, node: Node<NodeData>) => {
            onNodeSelected?.(node.data.onClickPayload);
        },
        [onNodeSelected],
    );

    if (graph.nodes.length === 0) {
        return (
            <div
                id={id}
                className={cn(
                    cardVariants({ density: 'none' }),
                    'text-center py-10 text-content-subtle',
                    className,
                )}
                data-graph-empty="true"
            >
                No traceability links to display.
            </div>
        );
    }

    // ═══ ATTRIBUTION SHOWN ON PURPOSE ═══
    //
    // `proOptions={{ hideAttribution: true }}` was set on the <ReactFlow> below.
    // React Flow is MIT and the option works without a subscription, but its terms
    // permit removing the attribution only with one:
    //   "Only remove this attribution, if you are subscribed to React Flow Pro."
    //
    // It was set in FOUR components and nobody could confirm the product holds a
    // subscription. Showing the badge costs pixels; hiding it unlicensed is an
    // unlicensed-use finding in a compliance product — so this fails in the safe
    // direction until procurement says otherwise. Re-adding is one line per site
    // the day it is confirmed.
    return (
        <div
            id={id}
            data-graph-explorer="true"
            data-node-count={graph.nodes.length}
            data-edge-count={graph.edges.length}
            data-match-count={highlight.matchCount}
            className={cn(
                'relative w-full h-[60vh] min-h-[24rem] rounded-md border border-border-default overflow-hidden',
                className,
            )}
        >
            <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={NODE_TYPES}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                onNodeClick={handleNodeClick}
                minZoom={0.2}
                maxZoom={2}
            >
                <Background gap={24} size={1} className="bg-bg-default" />
                <Controls className="!bg-bg-default !border-border-default" />
                <MiniMap
                    pannable
                    zoomable
                    className="!bg-bg-default !border-border-default"
                    nodeColor={(node) => {
                        const data = node.data as NodeData;
                        // MiniMap takes inline color strings; pull
                        // the same hex from COLOR_MAP so palette
                        // tweaks propagate everywhere.
                        return COLOR_MAP[data.color]?.minimap ?? '#94a3b8';
                    }}
                />
            </ReactFlow>
            {highlight.hasQuery && highlight.matchCount === 0 && (
                <div
                    data-graph-no-match="true"
                    className="absolute inset-x-0 top-2 mx-auto w-fit px-3 py-1.5 rounded-md bg-bg-elevated/95 border border-border-default text-xs text-content-muted shadow-md"
                    role="status"
                >
                    No matches for &ldquo;{searchQuery.trim()}&rdquo;
                </div>
            )}
        </div>
    );
}
