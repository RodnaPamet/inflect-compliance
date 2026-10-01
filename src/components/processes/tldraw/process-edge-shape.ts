/**
 * The DRAWN half of a process edge.
 *
 * ═══ WHY THERE ARE TWO RECORDS FOR ONE EDGE ═══
 *
 * `process-edge-binding.ts` argues that an edge must be a binding and not an
 * arrow, because `ProcessEdgeControl` hangs off the edge and coverage queries
 * read it — "an edge that were merely drawn would have nowhere to put a control
 * and nothing for a compliance query to find". That is right, and nothing here
 * changes it.
 *
 * But it settles the DATA model and not the drawing, and a `BindingUtil` cannot
 * draw: its declaration has `getDefaultProps` plus thirteen lifecycle hooks and
 * no `component()` or `indicator()`. So with bindings alone the canvas showed
 * nodes and no connectors — data-complete and visually absent. Every edge test
 * asserted the round trip; none asserted a line was drawn, which is how a green
 * suite sat over a canvas missing half its content.
 *
 * tldraw's own connectors are both things at once: `TLArrowShape` draws and
 * arrow bindings attach it. This is that split, applied here:
 *
 *   • the BINDING owns identity — `edgeKey`, `controls`, `sourceKey`/`targetKey`
 *     — and is what the serializer reads. Unchanged, so the save path is too.
 *   • this SHAPE owns pixels and hit-testing, which is also what makes an edge
 *     selectable: tldraw's selection API is shapes-only, so without a shape the
 *     edge inspector had nothing to select.
 *
 * ═══ DERIVED, NEVER PERSISTED ═══
 *
 * This shape is rebuilt from the bindings on every load, so `ProcessEdge` stays
 * the single source of truth and there is no second record to keep in step.
 *
 * That makes one thing load-bearing in the serializer: `partitionCanvas` ends
 * `else freeform.push(r)`, and `freeform` IS persisted to
 * `ProcessMap.freeformJson`. A derived shape falling into that bucket would be
 * written on save, then both re-derived AND restored on the next load —
 * duplicating, and compounding every time. So `partitionCanvas` sorts this type
 * into a `derived` bucket that nothing writes.
 *
 * ═══ THE GEOMETRY IS DERIVED TOO, WHICH IS WHY RESIZE IS LOCKED ═══
 *
 * `dx` / `dy` are the offset to the far endpoint, recomputed whenever either
 * bound node moves. They are not persisted, exactly like the node shape's
 * `w` / `h` — and that is the same argument for refusing resize: a capability
 * whose result cannot be saved is a capability that reports success and
 * discards.
 */
import { T, type RecordProps, type TLBaseShape, type TLShapeId } from 'tldraw';

/** The discriminator. Distinct from the binding's `process-edge`. */
export const PROCESS_EDGE_SHAPE_TYPE = 'process-edge-line' as const;

export type ProcessEdgeShapeProps = {
    /**
     * The edge this line draws, by the binding's `edgeKey`.
     *
     * The KEY and not the binding id, for the reason the binding file gives
     * about `sourceKey` vs `fromId`: a key is the contract that survives a
     * reload, and an id is tldraw's own wiring. Empty for a line drawn in the
     * editor before a key is minted for it.
     */
    edgeKey: string;
    /** Offset from this shape's origin to the far endpoint. Derived. */
    dx: number;
    dy: number;
};

export type ProcessEdgeShape = TLBaseShape<
    typeof PROCESS_EDGE_SHAPE_TYPE,
    ProcessEdgeShapeProps
>;

export const processEdgeShapeProps: RecordProps<ProcessEdgeShape> = {
    edgeKey: T.string,
    dx: T.number,
    dy: T.number,
};

/**
 * A stable shape id for an edge key.
 *
 * Deterministic for the same reason `shapeIdForNodeKey` is: seeding twice must
 * not produce two lines for one edge, and a derived record that minted a random
 * id each load would accumulate.
 */
export function shapeIdForEdgeKey(edgeKey: string): TLShapeId {
    return `shape:edge-${edgeKey}` as TLShapeId;
}

/** The inverse, for resolving a selected line back to its edge. */
export function edgeKeyFromShapeId(id: string): string | null {
    const prefix = 'shape:edge-';
    return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

/** The minimum of tldraw's `Box` this module needs. */
export interface CentredBounds {
    center: { x: number; y: number };
}

/**
 * Where an edge line sits, given its two endpoints' bounds.
 *
 * Pure, and shared by the two places that must agree: the seed on load and the
 * reposition when a node moves. Those were going to be separate expressions,
 * and a connector whose seeded position differs from its repositioned one jumps
 * the first time anything is dragged — a difference nothing would fail on,
 * because both halves are individually plausible.
 */
export function edgeLineGeometry(
    from: CentredBounds,
    to: CentredBounds,
): { x: number; y: number; dx: number; dy: number } {
    return {
        x: from.center.x,
        y: from.center.y,
        dx: to.center.x - from.center.x,
        dy: to.center.y - from.center.y,
    };
}
