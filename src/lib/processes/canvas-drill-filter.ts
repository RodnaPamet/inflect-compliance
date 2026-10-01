"use client";

/**
 * Epic P6-PR-A — Drill-scoped graph filter.
 *
 * Given the live nodes + edges and the current drill scope (a
 * group id or null for root), returns the subset of nodes + edges
 * that should render. Pure function — easy to unit-test, no React
 * state.
 *
 * Filtering rules:
 *   - At root (`groupId === null`):
 *     - Visible nodes: those with `parentId == null` (top-level)
 *       AND their immediate children (so a group RENDERS with
 *       its contents at root).
 *   - Inside a group (`groupId !== null`):
 *     - Visible nodes: those whose `parentId === groupId`. The
 *       group itself is hidden — the user is INSIDE it; no
 *       reason to render the container they entered.
 *   - Visible edges: both endpoints visible.
 *
 * Why exclude the parent group itself when drilled in:
 *   - The breadcrumb already announces "we are inside <group>".
 *   - Rendering the parent's box around its own contents is
 *     visual noise — the user wants to focus on the steps, not
 *     the chrome.
 */

/**
 * ── GENERIC, not merely structural ───────────────────────────────────
 *
 * This module took `Node[]` / `Edge[]` from `@xyflow/react` and read four
 * fields: `id`, `parentId`, `data.label`, and an edge's `source` / `target`.
 * The last two were already reached through casts, because xyflow types `data`
 * as `Record<string, unknown>` and does not declare `parentId` on the base
 * node at all.
 *
 * ── The root arm returns BY REFERENCE, and that is a contract ────────
 *
 * The root branch hands the same arrays straight back.
 * `tests/guards/p6a-subflow-drilldown.test.ts` pins that exact expression and
 * states the reason — "the filter must NOT mutate or copy the root case" — and
 * the unit test asserts identity on both arrays. Referential identity is what
 * lets a React caller skip re-rendering the whole graph at root.
 *
 * Deliberately NOT quoting the branch condition or the return expression here.
 * That guard masks comments, so prose cannot satisfy it today — but writing
 * code-shaped text into a file guards grep is how a needle stops being unique,
 * and the next guard to read this file may not mask.
 *
 * I added a defensive copy here while porting, on the theory that returning a
 * caller's own array through a mutable type was unsafe. It looked safer and was
 * a behaviour change; both tests caught it. The guard's comment had already
 * said so, which is the cheapest thing I could have read first.
 *
 * The explanation lives HERE and not beside the return because that guard
 * bounds its interior span to 200 characters: a long comment inside the branch
 * pushes the return past the bound and fails it. Widening the span would be the
 * wrong fix — bounded spans are what the Class C ratchet exists to keep.
 *
 * ── GENERIC rather than a fixed structural type ──────────────────────
 *
 * The difference matters. `canvas-auto-layout.ts` returns a fresh `positions` map, so a
 * structural INPUT type was enough there. This function FILTERS and hands the
 * same objects back, so a `DrillNode[]` return would strip whatever the caller
 * put in — the xyflow canvas would get `DrillNode[]` where it needs `Node[]`,
 * and a tldraw host the same. The constraint says what is read; the type
 * parameter preserves what was passed.
 */

/** The minimum of a node this module reads. */
export interface DrillNode {
    id: string;
    /** A group's children point at it. Not on xyflow's base `Node` type. */
    parentId?: string;
    /** Read only for the breadcrumb label. */
    data?: { label?: unknown } | null;
}

/** The minimum of an edge this module reads — endpoints, by node id. */
export interface DrillEdge {
    source: string;
    target: string;
}

export interface DrillFilterResult<N = DrillNode, E = DrillEdge> {
    visibleNodes: N[];
    visibleEdges: E[];
}

export function filterByDrillScope<N extends DrillNode, E extends DrillEdge>(
    nodes: N[],
    edges: E[],
    groupId: string | null,
): DrillFilterResult<N, E> {
    if (groupId === null) {
        // Root: every node is visible. The user expects the full
        // graph at this level.
        // BY REFERENCE, deliberately — see the header.
        return { visibleNodes: nodes, visibleEdges: edges };
    }
    const visibleIds = new Set<string>();
    for (const n of nodes) {
        const parentId = n.parentId;
        if (parentId === groupId) {
            visibleIds.add(n.id);
        }
    }
    const visibleNodes = nodes.filter((n) => visibleIds.has(n.id));
    const visibleEdges = edges.filter(
        (e) => visibleIds.has(e.source) && visibleIds.has(e.target),
    );
    return { visibleNodes, visibleEdges };
}

/**
 * Build the breadcrumb trail labels given the drill stack +
 * the live nodes (so we can look up display names).
 *
 * Returns an array of `{ id, label }` rows ordered root →
 * deepest. The root row is `{ id: null, label: "All processes" }`.
 */
export function buildDrillBreadcrumbs(
    stack: readonly string[],
    nodes: readonly DrillNode[],
    rootLabel = "All",
): Array<{ id: string | null; label: string }> {
    const trail: Array<{ id: string | null; label: string }> = [
        { id: null, label: rootLabel },
    ];
    for (const groupId of stack) {
        const node = nodes.find((n) => n.id === groupId);
        const label =
            (node?.data as { label?: unknown } | undefined)?.label;
        trail.push({
            id: groupId,
            label: typeof label === "string" && label.length > 0
                ? label
                : "Group",
        });
    }
    return trail;
}
