/**
 * Server-side layout of a PROPOSED process map (#5053).
 *
 * An agent's process-map proposal carries no positions (its schema refuses
 * them). This module places the steps, and it is the ONLY thing that does: the
 * review diff computes the boxes the reviewer's preview is drawn with, and
 * approval creates the map at the same boxes. What the reviewer sees is what
 * is created.
 *
 * ── WHY A SEPARATE MODULE, NOT `canvas-auto-layout.ts` ─────────────────────
 *
 * The canvas's own layout (`canvas-auto-layout.ts`) carries `"use client"`. A
 * server module that imports a client module receives a client reference, and
 * calling it throws in production while Jest and the worker, which ignore the
 * directive, pass. That file keeps its directive (owner decision, 2026-11-11),
 * and this one imports `@dagrejs/dagre` directly with the SAME settings the
 * canvas's "Arrange" (left to right) uses, so a proposed map comes out
 * arranged the way the canvas would arrange it.
 *
 * The copied numbers are pinned by `tests/unit/proposed-map-layout.test.ts`,
 * which reads `canvas-auto-layout.ts` and `tldraw/process-node-shape.ts` as
 * text: the node box is the tldraw shape's default size (220×88; dagre's
 * 80-high default would overlap), and the rank and node separations are the
 * canvas's. `process-node-shape.ts` imports tldraw and is off limits to server
 * code, hence the copies.
 *
 * SERVER-ONLY by convention: no client component imports it, so dagre never
 * reaches a page's First Load JS through it.
 */
import dagre from '@dagrejs/dagre';

import type { ProcessMapPreviewBox } from '@/lib/agentic/process-map-proposal';

/** `PROCESS_NODE_DEFAULT_W` in `components/processes/tldraw/process-node-shape.ts`. */
export const PROPOSED_NODE_WIDTH = 220;
/** `PROCESS_NODE_DEFAULT_H` in `components/processes/tldraw/process-node-shape.ts`. */
export const PROPOSED_NODE_HEIGHT = 88;
/** `RANKSEP` in `canvas-auto-layout.ts`. */
export const PROPOSED_RANKSEP = 80;
/** `NODESEP` in `canvas-auto-layout.ts`. */
export const PROPOSED_NODESEP = 48;
/** The graph margin `computeAutoLayout` passes dagre. */
export const PROPOSED_MARGIN = 32;
/** The canvas's default "Arrange" direction. */
export const PROPOSED_RANKDIR = 'LR';

/**
 * Top-left boxes, keyed by step key, rounded to integers.
 *
 * Deterministic for one input and one installed dagre: the steps and arrows
 * are added in their stored (canonical) order. dagre is a caret dependency,
 * so a different build MAY place a map differently; that is harmless because
 * the boxes are recomputed from the stored graph at review and again at
 * approval, never stored before approval.
 */
export function layoutProposedProcessMap(
    nodes: ReadonlyArray<{ nodeKey: string }>,
    edges: ReadonlyArray<{ sourceKey: string; targetKey: string }>,
): Record<string, ProcessMapPreviewBox> {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: PROPOSED_RANKDIR,
        ranksep: PROPOSED_RANKSEP,
        nodesep: PROPOSED_NODESEP,
        marginx: PROPOSED_MARGIN,
        marginy: PROPOSED_MARGIN,
    });
    g.setDefaultEdgeLabel(() => ({}));
    const keys = new Set<string>();
    for (const n of nodes) {
        g.setNode(n.nodeKey, { width: PROPOSED_NODE_WIDTH, height: PROPOSED_NODE_HEIGHT });
        keys.add(n.nodeKey);
    }
    for (const e of edges) {
        if (keys.has(e.sourceKey) && keys.has(e.targetKey)) g.setEdge(e.sourceKey, e.targetKey);
    }
    dagre.layout(g);

    const boxes: Record<string, ProcessMapPreviewBox> = {};
    for (const n of nodes) {
        const pos = g.node(n.nodeKey) as { x?: number; y?: number } | undefined;
        const cx = typeof pos?.x === 'number' && Number.isFinite(pos.x) ? pos.x : 0;
        const cy = typeof pos?.y === 'number' && Number.isFinite(pos.y) ? pos.y : 0;
        // dagre returns CENTRE coordinates; a process node is placed by its top-left.
        boxes[n.nodeKey] = {
            x: Math.round(cx - PROPOSED_NODE_WIDTH / 2),
            y: Math.round(cy - PROPOSED_NODE_HEIGHT / 2),
            w: PROPOSED_NODE_WIDTH,
            h: PROPOSED_NODE_HEIGHT,
        };
    }
    return boxes;
}
