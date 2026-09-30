/**
 * What the inspector needs to know about a selection — and nothing about which
 * engine produced it.
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * #2961 asks for a "library-agnostic selection adapter so [ProcessInspector]
 * never learns which engine is mounted", and says why in the next breath: *"That
 * adapter is also what makes the swap reviewable in pieces."*
 *
 * Without it, replacing the renderer means editing the inspector — 697 lines of
 * product behaviour (control pickers, BIA affordances, edge variants) that has
 * nothing to do with rendering — in the same diff as the canvas host. With it,
 * the inspector is finished and the swap is somebody else's problem.
 *
 * ═══ IT IS DELIBERATELY SMALLER THAN xyflow's `Node` / `Edge` ═══
 *
 * A structural clone of those types would be a second definition of the same
 * thing, drifting on the first upstream change, and would carry fields the
 * inspector has no business reading — `position`, `measured`, `dragging`,
 * `selected`, `zIndex`. Geometry belongs to the renderer; the inspector edits
 * MEANING.
 *
 * So this declares exactly the three things the inspector actually reads,
 * measured rather than guessed:
 *
 *   - `id`      — which is the `nodeKey` / `edgeKey`, not a row cuid. Both
 *                 engines use the client-stable key as the record id, which is
 *                 why `onUpdate(node.id, …)` has always addressed the right row.
 *   - `data`    — the opaque per-type payload. The inspector narrows it at each
 *                 read site (`data as { variant?: unknown }`), and that stays
 *                 its business: typing it here would make this file a consumer
 *                 of a forward-compatibility slot.
 *   - `label`   — edges only, and only because the edge inspector writes it.
 *
 * ═══ WHAT IT IS NOT ═══
 *
 * Not a general canvas abstraction, and not a place to add "while we are here"
 * fields. Every field added is one the next renderer must supply. If a future
 * inspector needs geometry, that is a sign the geometry belongs in the canvas
 * host instead.
 */

/**
 * A selected node, as the inspector sees it.
 *
 * `data` is `unknown` rather than an index signature on purpose: the read sites
 * already narrow it, and `Record<string, unknown>` would quietly permit
 * `data.whatever` with no complaint at exactly the places narrowing is the point.
 */
export interface SelectedCanvasNode {
    /** The client-stable `nodeKey`. NOT the `ProcessNode` row cuid. */
    id: string;
    data: unknown;
}

/** A selected edge, as the inspector sees it. */
export interface SelectedCanvasEdge {
    /** The client-stable `edgeKey`. NOT the `ProcessEdge` row cuid. */
    id: string;
    data: unknown;
    /**
     * The rendered label. Optional because a freshly drawn edge has none, and
     * `null` is how the inspector CLEARS one — so the three states are
     * distinguishable and `?? null` must not be applied on the way in.
     */
    label?: string | null;
}

/**
 * The selection, with the mutual exclusion the canvas actually enforces.
 *
 * xyflow permits multi-selecting a node and an edge together; the canvas mirrors
 * one slot at a time and node wins. That rule lived as a comment on the
 * inspector's props and as an `if` in its body. Stating it as a function keeps
 * the next renderer from having to rediscover it from the comment — and makes it
 * testable without mounting anything.
 */
export type CanvasSelection =
    | { kind: 'node'; node: SelectedCanvasNode }
    | { kind: 'edge'; edge: SelectedCanvasEdge }
    | { kind: 'none' };

export function resolveSelection(
    node: SelectedCanvasNode | null | undefined,
    edge: SelectedCanvasEdge | null | undefined,
): CanvasSelection {
    // NODE WINS. Not arbitrary: a node carries the richer inspector (type,
    // size, linked entity, BIA affordance), so resolving to the edge when both
    // are set would hide the more useful panel.
    if (node) return { kind: 'node', node };
    if (edge) return { kind: 'edge', edge };
    return { kind: 'none' };
}

/**
 * Narrow an engine's node record to the adapter's shape.
 *
 * Structurally typed on the way in — anything with a string `id` and a `data`
 * satisfies it, which both xyflow's `Node` and a tldraw shape's
 * `{ id, props }` projection can be mapped to without this file importing
 * either. That is the whole point: no engine is named here.
 */
export function toSelectedNode(
    record: { id: string; data?: unknown } | null | undefined,
): SelectedCanvasNode | null {
    return record ? { id: record.id, data: record.data ?? null } : null;
}

export function toSelectedEdge(
    record: { id: string; data?: unknown; label?: unknown } | null | undefined,
): SelectedCanvasEdge | null {
    if (!record) return null;
    return {
        id: record.id,
        data: record.data ?? null,
        ...labelOf(record),
    };
}

/**
 * The label, narrowed to what the product actually supports.
 *
 * `label` is `unknown` on the way in because xyflow types its own as
 * `ReactNode` — a number, an element and a fragment all satisfy that. The edge
 * inspector renders it into a TEXT INPUT, so only a string is editable, and it
 * already proved this by narrowing with `typeof edge.label === 'string'` at both
 * of its read sites.
 *
 * Doing it once here means the adapter's type is honest rather than optimistic.
 * A non-string label is dropped rather than coerced: `String(<div/>)` would put
 * `[object Object]` in the input and then SAVE it, turning a rendering choice
 * into persisted data.
 *
 * The inspector's own `typeof` checks are left in place — they are now provably
 * true, cost nothing, and removing them is a tidy-up rather than part of this
 * seam.
 */
function labelOf(record: { label?: unknown }): { label?: string | null } {
    if (!('label' in record)) return {};
    // `null` is preserved and NOT folded into `undefined`: the inspector writes
    // null to CLEAR a label, so the two states must stay distinguishable.
    if (record.label === null) return { label: null };
    return typeof record.label === 'string' ? { label: record.label } : {};
}
