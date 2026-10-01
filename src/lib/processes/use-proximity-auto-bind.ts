/**
 * Roadmap-26 PR-C — Proximity auto-bind hook.
 *
 * Drag-near-target connection assistance for the Processes canvas.
 * When the user drags a node close enough to another node, the hook
 * surfaces a "candidate edge" preview; on drag stop with the
 * candidate still in range, the preview commits as a real edge.
 *
 * Design constraints (per the R26-PR-C brief):
 *   • Predictable — never bind further than `THRESHOLD_PX` of
 *     centre-to-centre distance. Drag is the canonical authoring
 *     gesture; users dragging across the canvas to RE-position
 *     a node must not accidentally hook every node they pass.
 *   • Visual feedback — the canvas reads `candidate` and renders
 *     a phantom edge so the user SEES the auto-bind before
 *     committing. Cancellable by dragging out of range BEFORE
 *     mouse-up.
 *   • Direction-aware — the dragged node is treated as the SOURCE
 *     when its centre is LEFT of the candidate target's centre
 *     (matches the canvas's left-to-right reading direction).
 *     RIGHT-of-target → reverse: target becomes source. The
 *     symmetric inference keeps drag-to-the-left meaningful for
 *     users authoring right-to-left.
 *   • Respect existing topology — if an edge already exists
 *     between the pair (in EITHER direction), the candidate is
 *     suppressed. Auto-bind never duplicates edges.
 *   • Respect handle compatibility — kinds without handles
 *     (annotation) are never auto-bound. The hook reads each
 *     node's `data.kind` and consults the taxonomy.
 *   • Cheap — runs on every drag tick, so the find-closest is a
 *     linear scan with cheap arithmetic; O(N) per tick is fine
 *     for the bounded graph sizes the Processes page targets.
 *
 * What's NOT here:
 *   • Auto-bind on node CREATION (i.e. dropping from the palette
 *     near an existing node). Out of scope per the brief — the
 *     auto-bind affordance is for REPOSITION-time only.
 *   • Multi-target candidates (e.g. one source, two targets).
 *     The canvas would have to render two preview edges; the
 *     user would have to remember which one commits on drag
 *     stop. Single-candidate is the explicit choice.
 *   • Snapping the node's POSITION (i.e. magnetic alignment).
 *     PR-E's alignment helpers cover that. This hook is about
 *     connections only.
 */

import { useCallback, useState } from "react";
import {
    NODE_TAXONOMY,
    isProcessNodeKind,
} from "@/components/processes/node-taxonomy";

/**
 * Pixel threshold for proximity. ~80px feels deliberate: nodes
 * have to be visibly close (the dragged node's edge overlapping
 * the candidate's neighbourhood) before the bind kicks in.
 * Smaller (40px) requires nose-to-nose collision which most
 * authors miss; larger (120px) starts to fire while passing by.
 *
 * Tunable via the hook's `threshold` option for the rare case
 * (e.g. dense graphs) where a different default reads better.
 */
/**
 * ── The node/edge types are STRUCTURAL, not either engine's ──────────
 *
 * This module took `Node[]` / `Edge[]` from `@xyflow/react` and read six
 * fields: `id`, `position`, `width`, `height`, `data` (for the kind) and an
 * edge's `source` / `target`. There was no runtime xyflow import at all — the
 * only one was `import type`.
 *
 * That mattered for the cutover: phase 4 deletes every module importing
 * xyflow, so proximity auto-bind would have gone with it, and tldraw has no
 * equivalent. The geometry here is about distances between boxes and knows
 * nothing about a renderer.
 *
 * ── What is still xyflow-SHAPED, and honestly so ─────────────────────
 *
 * `onNodeDrag` / `onNodeDragStop` mirror xyflow's drag-event callbacks: two
 * arguments, the event first and ignored. The types no longer name xyflow, so a
 * tldraw host CAN call them, but it has to drive them from its own store
 * listener rather than find them handed to it by the canvas. The pure core
 * (`findProximityCandidate`) is what ports cleanly; the hook is a wrapper whose
 * shape still remembers where it came from.
 */

/** The minimum of a positioned node this module reads. */
export interface ProximityNode {
    id: string;
    position: { x: number; y: number };
    /**
     * Measured size, when the host has reported one.
     *
     * TWO shapes because xyflow reports both: `width`/`height` on the node, and
     * a `measured` sub-object which is the one that actually gets populated
     * after layout. `measured` wins when present — see `nodeCentre`.
     *
     * Declared rather than cast. A cast was how `measured` got read before, and
     * it is why a field enumeration over `n.<field>` accesses missed it: the
     * access was `(n as Node & {...}).measured`, so the field name never
     * appeared attached to the variable. `tsc` named the line.
     */
    width?: number | null;
    height?: number | null;
    measured?: { width?: number; height?: number } | null;
    /** Read only to decide whether this kind can take a connection. */
    data?: { kind?: unknown } | null;
}

/** The minimum of an edge this module reads — endpoints, by node id. */
export interface ProximityEdge {
    source: string;
    target: string;
}

export const DEFAULT_PROXIMITY_THRESHOLD_PX = 80;

export interface ProximityCandidate {
    /** Source node id (xyflow node id, i.e. nodeKey). */
    source: string;
    /** Target node id. */
    target: string;
    /** Distance at the moment the candidate was last computed. */
    distance: number;
}

export interface UseProximityAutoBindOptions {
    /** Override the proximity threshold (default 80px). */
    threshold?: number;
    /**
     * Called when the user releases the drag and a candidate is
     * still in range. The canvas commits the candidate to its
     * edges state from this callback.
     */
    onCommit?: (candidate: ProximityCandidate) => void;
}

export interface UseProximityAutoBindResult {
    /** xyflow `onNodeDrag` handler — recompute the candidate. */
    onNodeDrag: (_event: unknown, draggedNode: ProximityNode) => void;
    /** xyflow `onNodeDragStop` handler — commit + clear. */
    onNodeDragStop: (_event: unknown, draggedNode: ProximityNode) => void;
    /**
     * Current candidate (or null). Consumer-provided UI reads
     * this to render the preview edge.
     */
    candidate: ProximityCandidate | null;
    /**
     * Pure helper exposed for testing — given the dragged node + a
     * snapshot of all nodes + the current edge set, returns the
     * best candidate or null. Decoupled from the hook's state so
     * unit tests can exercise the geometry without mounting React.
     */
    findCandidate: (
        draggedNode: ProximityNode,
        allNodes: readonly ProximityNode[],
        edges: readonly ProximityEdge[],
        threshold?: number,
    ) => ProximityCandidate | null;
}

// ─── Geometry helpers ──────────────────────────────────────────────

/**
 * Returns the centre of a node, accounting for measured size when
 * xyflow has reported it. Falls back to the position (top-left)
 * when size hasn't been measured yet — early ticks of a fresh
 * graph occasionally hit this. The fallback is monotone — a node
 * with no size is treated as a point at its origin; not perfect
 * but good enough for the proximity check.
 */
function nodeCentre(n: ProximityNode): { x: number; y: number } {
    const measured = n.measured;
    const w =
        measured?.width ??
        (n.width !== undefined && n.width !== null ? n.width : 160);
    const h =
        measured?.height ??
        (n.height !== undefined && n.height !== null ? n.height : 60);
    return {
        x: n.position.x + w / 2,
        y: n.position.y + h / 2,
    };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Returns true if the given node kind can carry handles. Annotation
 * is the only kind today that opts out. Forward-compatible: an
 * unknown kind is treated as "has handles" so a future kind
 * doesn't silently lose the auto-bind affordance.
 */
function nodeHasHandles(n: ProximityNode): boolean {
    const data = n.data as { kind?: unknown } | undefined;
    const kind = data?.kind;
    if (!isProcessNodeKind(kind)) return true;
    return NODE_TAXONOMY[kind].hasHandles;
}

function edgeExists(
    edges: readonly ProximityEdge[],
    a: string,
    b: string,
): boolean {
    return edges.some(
        (e) =>
            (e.source === a && e.target === b) ||
            (e.source === b && e.target === a),
    );
}

/**
 * Pure candidate-finder. Exported (via the hook's return) so
 * tests can exercise the geometry without React.
 */
export function findProximityCandidate(
    draggedNode: ProximityNode,
    allNodes: readonly ProximityNode[],
    edges: readonly ProximityEdge[],
    threshold: number = DEFAULT_PROXIMITY_THRESHOLD_PX,
): ProximityCandidate | null {
    if (!nodeHasHandles(draggedNode)) return null;

    const draggedCentre = nodeCentre(draggedNode);
    let best: { node: ProximityNode; dist: number } | null = null;

    for (const other of allNodes) {
        if (other.id === draggedNode.id) continue;
        if (!nodeHasHandles(other)) continue;
        if (edgeExists(edges, draggedNode.id, other.id)) continue;
        const d = distance(draggedCentre, nodeCentre(other));
        if (d > threshold) continue;
        if (!best || d < best.dist) {
            best = { node: other, dist: d };
        }
    }

    if (!best) return null;

    // Direction inference — left-of-target → drag is source.
    const targetCentre = nodeCentre(best.node);
    const draggedIsSource = draggedCentre.x <= targetCentre.x;

    return {
        source: draggedIsSource ? draggedNode.id : best.node.id,
        target: draggedIsSource ? best.node.id : draggedNode.id,
        distance: best.dist,
    };
}

// ─── Hook ──────────────────────────────────────────────────────────

export function useProximityAutoBind(
    nodes: readonly ProximityNode[],
    edges: readonly ProximityEdge[],
    options: UseProximityAutoBindOptions = {},
): UseProximityAutoBindResult {
    const threshold = options.threshold ?? DEFAULT_PROXIMITY_THRESHOLD_PX;
    const { onCommit } = options;
    const [candidate, setCandidate] = useState<ProximityCandidate | null>(
        null,
    );

    const onNodeDrag = useCallback(
        (_event: unknown, draggedNode: ProximityNode) => {
            const next = findProximityCandidate(
                draggedNode,
                nodes,
                edges,
                threshold,
            );
            setCandidate((prev) => {
                // Avoid unnecessary re-renders when the candidate is
                // unchanged. xyflow fires `onNodeDrag` on every
                // pixel of motion; without this gate the canvas
                // would re-render on every tick whether or not the
                // candidate changed.
                if (!prev && !next) return prev;
                if (
                    prev &&
                    next &&
                    prev.source === next.source &&
                    prev.target === next.target
                ) {
                    return prev;
                }
                return next;
            });
        },
        [nodes, edges, threshold],
    );

    const onNodeDragStop = useCallback(
        (_event: unknown, _draggedNode: ProximityNode) => {
            // Snapshot the current candidate BEFORE clearing — the
            // setState callback in onNodeDrag may not have flushed
            // yet at the instant the drag ends, so we re-run the
            // finder against the latest props as a safety net.
            const latest = findProximityCandidate(
                _draggedNode,
                nodes,
                edges,
                threshold,
            );
            if (latest && onCommit) onCommit(latest);
            setCandidate(null);
        },
        [nodes, edges, threshold, onCommit],
    );

    return {
        onNodeDrag,
        onNodeDragStop,
        candidate,
        findCandidate: findProximityCandidate,
    };
}
