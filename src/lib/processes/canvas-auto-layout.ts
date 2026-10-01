"use client";

/**
 * Epic P4-PR-A + PR-C polish — Canvas auto-layout via dagre + elkjs.
 *
 * Closes the brief's #1 🟠 "Auto-Layout Engine" gap. Pre-P4
 * authors had to manually position every node; a 20-node map
 * (typical for a compliance process) is hours of drag-and-align.
 * Auto-layout hits the same shape Visio + Figma + Lucidchart all
 * ship: pick a direction, click "Arrange", every node snaps to a
 * hierarchical layout in one move.
 *
 * Two engines, one module:
 *   - **dagre** (`computeAutoLayout`) — hierarchical (LR / TB).
 *     The default; covers ≥90% of compliance maps where a
 *     directional flow ("intake → review → approve") is the
 *     mental model.
 *   - **elkjs** (`computeForceLayout`) — force-directed (organic).
 *     PR-C polish add. Covers the long tail: cycles, undirected
 *     dependency webs, maps with no clear start node. Async-only
 *     (elkjs returns a Promise), dynamically imported so the
 *     ~600KB bundle only ships when the user invokes it.
 *
 * Why a helper not a hook:
 *   - The functions are stateless — take nodes + edges + opts,
 *     return new positions. The canvas owns "push history,
 *     setNodes, markDirty"; this module just answers "where do
 *     the nodes go?".
 *   - Easier to unit-test (no React render).
 */

import dagre from "@dagrejs/dagre";
/**
 * ── The input types are STRUCTURAL, not either engine's ──────────────
 *
 * This module used to take `Node[]` / `Edge[]` from `@xyflow/react`, which made
 * a graph-layout algorithm depend on a renderer. It never needed one: the six
 * fields it reads are `id`, `position`, `data`, `style`, `source` and `target`,
 * and `data` / `style` were ALREADY reached through structural casts because
 * xyflow types them as `Record<string, unknown>` and `CSSProperties`.
 *
 * The practical consequence is that phase 4 would have deleted auto-layout
 * along with the xyflow canvas — dagre LR/TB, selection-only, and the
 * force-directed variant, six commands in all, with no tldraw equivalent to
 * replace them, because tldraw has no graph auto-layout of any kind.
 *
 * xyflow's `Node` and `Edge` remain assignable to these, so the existing caller
 * is untouched; a tldraw host supplies the same shape from its own records.
 * Asserted both ways in `tests/unit/processes/auto-layout-is-engine-free.test.ts`
 * rather than left to the next person to discover.
 */

/** The minimum of a positioned node this module reads. */
export interface LayoutNode {
    id: string;
    position: { x: number; y: number };
    /**
     * Read ONLY for `kind === 'annotation'`, which is skipped: annotations are
     * floating tags that do not participate in the flow direction.
     */
    data?: { kind?: unknown } | null;
    /** Measured size, where the host has one. Falls back to the constants below. */
    style?: { width?: unknown; height?: unknown } | null;
}

/**
 * The minimum of an edge this module reads.
 *
 * `id` is needed by the elk (force-directed) path, which requires edge
 * identity where dagre does not. Worth recording how it got left out: the
 * field surface was enumerated as a flat set — `id`, `position`, `data`,
 * `style`, `source`, `target` — and `id` was then assigned to the NODE type
 * only. The enumeration was right and the split was wrong, which a flat list
 * cannot show you. `tsc` named the line.
 */
export interface LayoutEdge {
    id: string;
    source: string;
    target: string;
}

export type AutoLayoutDirection = "LR" | "TB";

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 80;
// Group nodes are larger by design; the canvas defaults them to
// 280×160. We pass those measurements to dagre so the algorithm
// allocates appropriate spacing.
const GROUP_NODE_WIDTH = 280;
const GROUP_NODE_HEIGHT = 160;
const RANKSEP = 80;
const NODESEP = 48;

export interface AutoLayoutResult {
    /** New positions keyed by xyflow node id. */
    positions: Record<string, { x: number; y: number }>;
}

/**
 * Compute auto-layout positions for the supplied graph. The
 * caller applies the positions via `setNodes(prev => prev.map(...))`
 * and pushes the prior state to history.
 *
 * Nodes whose `data.kind === 'annotation'` are skipped — they're
 * floating tags that don't participate in the flow direction.
 *
 * `nodeIdsFilter` (optional) scopes the layout to a subset of node
 * ids — used by the "Auto-arrange selection" command. Edges whose
 * endpoints fall outside the filter are dropped from dagre (so the
 * algorithm only routes among the selected nodes); non-filtered
 * nodes keep their current positions and the returned `positions`
 * map omits them.
 */
export function computeAutoLayout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    direction: AutoLayoutDirection,
    nodeIdsFilter?: ReadonlySet<string>,
): AutoLayoutResult {
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: direction,
        ranksep: RANKSEP,
        nodesep: NODESEP,
        marginx: 32,
        marginy: 32,
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Track which nodes participate so we don't add positions for
    // skipped (annotation) nodes.
    const participatingIds = new Set<string>();
    for (const node of nodes) {
        const kind = (node.data as { kind?: unknown } | undefined)?.kind;
        if (kind === "annotation") continue;
        if (nodeIdsFilter && !nodeIdsFilter.has(node.id)) continue;
        // Use the node's measured dimensions if the host supplies them,
        // else the design defaults. Group nodes get the larger box.
        const measuredW =
            (node as { width?: number | null }).width ??
            ((node.style as { width?: unknown } | undefined)?.width as number);
        const measuredH =
            (node as { height?: number | null }).height ??
            ((node.style as { height?: unknown } | undefined)?.height as number);
        const isGroup = kind === "group";
        const w =
            typeof measuredW === "number" && Number.isFinite(measuredW)
                ? measuredW
                : isGroup
                  ? GROUP_NODE_WIDTH
                  : DEFAULT_NODE_WIDTH;
        const h =
            typeof measuredH === "number" && Number.isFinite(measuredH)
                ? measuredH
                : isGroup
                  ? GROUP_NODE_HEIGHT
                  : DEFAULT_NODE_HEIGHT;
        g.setNode(node.id, { width: w, height: h });
        participatingIds.add(node.id);
    }

    for (const edge of edges) {
        if (
            participatingIds.has(edge.source) &&
            participatingIds.has(edge.target)
        ) {
            g.setEdge(edge.source, edge.target);
        }
    }

    dagre.layout(g);

    const positions: Record<string, { x: number; y: number }> = {};
    for (const id of participatingIds) {
        const pos = g.node(id);
        if (!pos) continue;
        // dagre returns CENTRE coords; xyflow wants TOP-LEFT.
        const w = (pos.width as number) ?? DEFAULT_NODE_WIDTH;
        const h = (pos.height as number) ?? DEFAULT_NODE_HEIGHT;
        positions[id] = {
            x: pos.x - w / 2,
            y: pos.y - h / 2,
        };
    }

    return finaliseSubsetPositions(
        positions,
        nodes,
        participatingIds,
        nodeIdsFilter,
    );
}

/**
 * Re-centre the laid-out subset so its post-layout centroid lands
 * on top of its pre-layout centroid. Used by both `computeAutoLayout`
 * (dagre) and `computeForceLayout` (elkjs) when a `nodeIdsFilter`
 * is supplied — without this, both algorithms would dump the subset
 * near (0, 0), wildly off from where the user expects to see it.
 *
 * No-op when `nodeIdsFilter` is absent (full-canvas layouts always
 * land near origin by design).
 */
function finaliseSubsetPositions(
    positions: Record<string, { x: number; y: number }>,
    nodes: readonly LayoutNode[],
    participatingIds: ReadonlySet<string>,
    nodeIdsFilter: ReadonlySet<string> | undefined,
): AutoLayoutResult {
    if (!nodeIdsFilter || participatingIds.size === 0) {
        return { positions };
    }
    const before = { x: 0, y: 0, count: 0 };
    const after = { x: 0, y: 0, count: 0 };
    for (const node of nodes) {
        if (!participatingIds.has(node.id)) continue;
        before.x += node.position.x;
        before.y += node.position.y;
        before.count += 1;
    }
    for (const id of participatingIds) {
        const p = positions[id];
        if (!p) continue;
        after.x += p.x;
        after.y += p.y;
        after.count += 1;
    }
    if (before.count > 0 && after.count > 0) {
        const dx = before.x / before.count - after.x / after.count;
        const dy = before.y / before.count - after.y / after.count;
        for (const id of Object.keys(positions)) {
            positions[id] = {
                x: positions[id].x + dx,
                y: positions[id].y + dy,
            };
        }
    }
    return { positions };
}

/**
 * PR-C polish — Force-directed layout via elkjs (Eclipse Layout
 * Kernel, JS port). The function shape mirrors `computeAutoLayout`
 * with one critical difference: it's ASYNC. elkjs runs its layout
 * engine in a promise; the caller awaits the result before
 * applying positions.
 *
 * elkjs is dynamically imported so the ~600KB bundle ships only
 * when the user actually triggers force-layout — keeps the canvas's
 * initial bundle slim.
 *
 * Coords: elkjs returns top-left positions natively (no centre-
 * to-top-left conversion needed like dagre).
 *
 * `nodeIdsFilter` (optional) works the same way as the dagre
 * variant: subset-only with centroid preservation.
 */
export async function computeForceLayout(
    nodes: readonly LayoutNode[],
    edges: readonly LayoutEdge[],
    nodeIdsFilter?: ReadonlySet<string>,
): Promise<AutoLayoutResult> {
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    const elk = new ELK();

    const participatingIds = new Set<string>();
    const elkChildren: Array<{ id: string; width: number; height: number }> =
        [];
    for (const node of nodes) {
        const kind = (node.data as { kind?: unknown } | undefined)?.kind;
        if (kind === "annotation") continue;
        if (nodeIdsFilter && !nodeIdsFilter.has(node.id)) continue;
        const measuredW =
            (node as { width?: number | null }).width ??
            ((node.style as { width?: unknown } | undefined)?.width as number);
        const measuredH =
            (node as { height?: number | null }).height ??
            ((node.style as { height?: unknown } | undefined)?.height as number);
        const isGroup = kind === "group";
        const w =
            typeof measuredW === "number" && Number.isFinite(measuredW)
                ? measuredW
                : isGroup
                  ? GROUP_NODE_WIDTH
                  : DEFAULT_NODE_WIDTH;
        const h =
            typeof measuredH === "number" && Number.isFinite(measuredH)
                ? measuredH
                : isGroup
                  ? GROUP_NODE_HEIGHT
                  : DEFAULT_NODE_HEIGHT;
        elkChildren.push({ id: node.id, width: w, height: h });
        participatingIds.add(node.id);
    }

    const elkEdges = edges
        .filter(
            (e) =>
                participatingIds.has(e.source) &&
                participatingIds.has(e.target),
        )
        .map((e) => ({
            id: e.id,
            sources: [e.source],
            targets: [e.target],
        }));

    const result = await elk.layout({
        id: "root",
        layoutOptions: {
            // ELK's force algorithm — physical-spring simulation.
            // 300 iterations is the documented sweet spot: enough
            // for the graph to settle, cheap enough to feel
            // interactive at the canvas's bounded sizes.
            "elk.algorithm": "force",
            "elk.force.iterations": "300",
            "elk.spacing.nodeNode": "60",
        },
        children: elkChildren,
        edges: elkEdges,
    });

    const positions: Record<string, { x: number; y: number }> = {};
    for (const child of result.children ?? []) {
        if (typeof child.x === "number" && typeof child.y === "number") {
            positions[child.id] = { x: child.x, y: child.y };
        }
    }

    return finaliseSubsetPositions(
        positions,
        nodes,
        participatingIds,
        nodeIdsFilter,
    );
}
