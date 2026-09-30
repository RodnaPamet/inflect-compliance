/**
 * rows ⇄ tldraw. The persistence contract for the process canvas.
 *
 * ═══ THE ONE RESULT THE PROJECT DEPENDS ON ═══
 *
 * `rowsToTldraw(tldrawToRows(x))` must reproduce `x` exactly. #2963 states the
 * consequence: if a load/save cycle with no user edit does not produce an
 * identical row set, autosave writes spurious versions forever and every diff
 * becomes noise. #2959 measured it exact on a spike; this is that contract in
 * production types.
 *
 * ═══ ROWS STAY THE SOURCE OF TRUTH ═══
 *
 * The process map is not a drawing. It is normalised `ProcessNode` /
 * `ProcessEdge` / `ProcessEdgeControl` rows that coverage, traceability and
 * automation query. This module projects those rows into shapes a renderer can
 * draw and back again — it never makes the renderer's document authoritative.
 *
 * ═══ THREE PLACES A ROUND TRIP NORMALLY ACQUIRES A DIFFERENCE ═══
 *
 * 1. `undefined` vs `null`. The wire schema admits both for every optional
 *    field; the row stores `null`. Normalising in ONE direction only is how a
 *    projection acquires a difference invisible to a reader and fatal to
 *    `toEqual`. Every optional is `?? null` on BOTH sides here.
 *
 * 2. GEOMETRY. Position lives on the tldraw shape (`x`/`y`), never in props or
 *    `dataJson`. Dragging a node updates `x`/`y` and nothing else, so reading
 *    position from anywhere else silently discards the move.
 *
 * 3. FREEFORM. Sticky notes and freehand are NOT process nodes. They travel
 *    out to `ProcessMap.freeformJson` and back, and never become rows — see
 *    `tests/integration/freeform-never-becomes-a-node.test.ts` for the half of
 *    that guarantee the database enforces.
 */
import type {
    ProcessEdgeInput,
    ProcessNodeInput,
} from '@/app-layer/schemas/process-map';
import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_SHAPE_TYPE,
    shapeIdForNodeKey,
    type ProcessNodeShapeProps,
} from './process-node-shape';
import {
    PROCESS_EDGE_BINDING_TYPE,
    type ProcessEdgeBindingProps,
} from './process-edge-binding';
import { validateEdge, type EdgeEndpointRefusal } from './edge-validation';

/** The normalised graph, exactly as the save payload carries it. */
export interface GraphRows {
    nodes: ProcessNodeInput[];
    edges: ProcessEdgeInput[];
}

/**
 * Anything on the canvas that is not a process node or edge.
 *
 * Opaque on purpose: the projection carries these without understanding them,
 * because the moment it understands one somebody will be tempted to derive a
 * compliance fact from it.
 */
export interface FreeformRecord {
    id: string;
    type: string;
    [k: string]: unknown;
}

/**
 * What this module produces and consumes — NOT a full `TLShape`.
 *
 * A complete tldraw record carries `rotation`, `index`, `parentId`, `isLocked`,
 * `opacity`, `meta`, `typeName` and a branded `TLShapeId`. Claiming to produce
 * one would mean either inventing those values here or casting, and both are
 * worse than saying what this actually is: the fields the ROW determines, which
 * is exactly what tldraw's create APIs accept as a partial and fill the rest of.
 *
 * `id` is a plain `string` for the same reason — the branded type belongs at the
 * boundary where a record is handed to the editor, not in a projection whose
 * other consumer is a JSON save payload.
 */
export interface ProcessNodeShapeRecord {
    id: string;
    type: typeof PROCESS_NODE_SHAPE_TYPE;
    x: number;
    y: number;
    props: ProcessNodeShapeProps;
}

export interface ProcessEdgeBindingRecord {
    id: string;
    type: typeof PROCESS_EDGE_BINDING_TYPE;
    fromId: string;
    toId: string;
    props: ProcessEdgeBindingProps;
}

export interface TldrawGraph {
    shapes: ProcessNodeShapeRecord[];
    bindings: ProcessEdgeBindingRecord[];
    /** Persisted to `ProcessMap.freeformJson`, never to `ProcessNode`. */
    freeform: FreeformRecord[];
}

/** Raised when a binding names an endpoint the graph cannot accept. */
export class EdgeEndpointError extends Error {
    constructor(
        readonly edgeKey: string,
        readonly refusals: EdgeEndpointRefusal[],
    ) {
        super(
            `edge ${edgeKey || '(unkeyed)'} has invalid endpoints: ` +
                refusals.map((r) => `${r.code}(${r.nodeKey})`).join(', '),
        );
        this.name = 'EdgeEndpointError';
    }
}

/** Anything a canvas can hand back: one of ours, or something we do not read. */
export type CanvasRecord =
    | ProcessNodeShapeRecord
    | ProcessEdgeBindingRecord
    | FreeformRecord;

// Type PREDICATES, not booleans, so the partition needs no casts. A cast there
// would be the projection asserting a shape it has not checked.
export const isProcessNodeShape = (r: CanvasRecord): r is ProcessNodeShapeRecord =>
    r.type === PROCESS_NODE_SHAPE_TYPE;

export const isProcessEdgeBinding = (r: CanvasRecord): r is ProcessEdgeBindingRecord =>
    r.type === PROCESS_EDGE_BINDING_TYPE;

/** `edgeKey` → the binding id it always produces. Deterministic, like shapes. */
export function bindingIdForEdgeKey(edgeKey: string): string {
    return `binding:${edgeKey}`;
}

// ─── rows → tldraw ─────────────────────────────────────────────────────

export function rowsToTldraw(
    rows: GraphRows,
    freeform: FreeformRecord[] = [],
): TldrawGraph {
    return {
        freeform,
        shapes: rows.nodes.map((n) => ({
            id: shapeIdForNodeKey(n.nodeKey),
            type: PROCESS_NODE_SHAPE_TYPE,
            // POSITION LIVES HERE and nowhere else.
            x: n.posX,
            y: n.posY,
            props: {
                // Size is the renderer's own, not the row's — the defaults, so
                // a node loaded from a row looks like one that was just drawn.
                w: PROCESS_NODE_DEFAULT_W,
                h: PROCESS_NODE_DEFAULT_H,
                nodeKey: n.nodeKey,
                nodeType: n.nodeType,
                label: n.label,
                subtitle: n.subtitle ?? null,
                parentNodeKey: n.parentNodeKey ?? null,
                dataJson: n.dataJson ?? null,
            },
        })),
        bindings: rows.edges.map((e) => ({
            id: bindingIdForEdgeKey(e.edgeKey),
            type: PROCESS_EDGE_BINDING_TYPE,
            fromId: shapeIdForNodeKey(e.sourceKey),
            toId: shapeIdForNodeKey(e.targetKey),
            props: {
                edgeKey: e.edgeKey,
                sourceKey: e.sourceKey,
                targetKey: e.targetKey,
                edgeKind: e.edgeKind,
                labelOverride: e.labelOverride ?? null,
                dataJson: e.dataJson ?? null,
                // CONTROLS NEED THE SAME NORMALISATION. `ProcessEdgeInput`
                // declares each control's `dataJson` OPTIONAL, so an omitted one
                // arrives `undefined` while the row stores `null`. Passing the
                // array through unchanged would leave exactly the
                // undefined-vs-null difference this module exists to prevent —
                // invisible to a reader, fatal to `toEqual`, and only on edges
                // that carry controls, which is the subset least likely to be
                // in a fixture.
                controls: (e.controls ?? []).map((c) => ({
                    controlKey: c.controlKey,
                    label: c.label,
                    controlId: c.controlId,
                    dataJson: c.dataJson ?? null,
                })),
            },
        })),
    };
}

// ─── tldraw → rows ─────────────────────────────────────────────────────

/**
 * Split a canvas into the structured graph and everything else.
 *
 * The filter IS the contract, not a formality: a real store hands back
 * everything on the canvas, so this is the only place that decides a sticky
 * note is not a process step.
 */
export function partitionCanvas(records: readonly CanvasRecord[]): {
    shapes: ProcessNodeShapeRecord[];
    bindings: ProcessEdgeBindingRecord[];
    freeform: FreeformRecord[];
} {
    const shapes: ProcessNodeShapeRecord[] = [];
    const bindings: ProcessEdgeBindingRecord[] = [];
    const freeform: FreeformRecord[] = [];
    for (const r of records) {
        if (isProcessNodeShape(r)) shapes.push(r);
        else if (isProcessEdgeBinding(r)) bindings.push(r);
        else freeform.push(r);
    }
    return { shapes, bindings, freeform };
}

export function tldrawToRows(graph: TldrawGraph): GraphRows {
    // Only process shapes become rows. Typed as such, but a real store is not
    // typed — `partitionCanvas` is what makes this true, and the test for it
    // feeds in a sticky note.
    const shapes = graph.shapes.filter(isProcessNodeShape);

    /**
     * `nodeKey` by shape id — the ONLY correct way to resolve an endpoint.
     *
     * The spike this ports from read endpoints with `nodeKeyFromShapeId(fromId)`,
     * stripping the `shape:` prefix. That is right for a shape loaded FROM a
     * row, whose id was minted from its key, and WRONG for one the user drew:
     * tldraw gives that a random id, so the strip yields a key naming no node.
     * The shape's own `props.nodeKey` is authoritative in both cases.
     */
    const keyByShapeId = new Map(shapes.map((s) => [String(s.id), s.props.nodeKey]));
    const known = shapes.map((s) => ({
        nodeKey: s.props.nodeKey,
        nodeType: s.props.nodeType,
    }));

    for (const b of graph.bindings) {
        const sourceKey = keyByShapeId.get(String(b.fromId)) ?? '';
        const targetKey = keyByShapeId.get(String(b.toId)) ?? '';
        // Reuses the editor's own validator, so a save cannot accept an edge
        // the canvas refused to draw — one rule, not two that drift.
        const refusals = validateEdge(sourceKey, targetKey, known);
        if (refusals.length > 0) throw new EdgeEndpointError(b.props.edgeKey, refusals);
    }

    return {
        nodes: shapes.map((s) => ({
            nodeKey: s.props.nodeKey,
            nodeType: s.props.nodeType,
            label: s.props.label,
            subtitle: s.props.subtitle ?? null,
            // GEOMETRY FROM THE SHAPE. Dragging a node updates x/y and nothing
            // else; reading position from props would discard every move.
            posX: s.x,
            posY: s.y,
            parentNodeKey: s.props.parentNodeKey ?? null,
            dataJson: s.props.dataJson ?? null,
        })),
        edges: graph.bindings.map((b) => ({
            edgeKey: b.props.edgeKey,
            // Endpoints from the BINDING, resolved through the shape. These are
            // what a user edits by re-attaching an end; `props.sourceKey` is a
            // denormalised convenience that goes stale the moment one moves.
            sourceKey: keyByShapeId.get(String(b.fromId)) ?? b.props.sourceKey,
            targetKey: keyByShapeId.get(String(b.toId)) ?? b.props.targetKey,
            edgeKind: b.props.edgeKind,
            labelOverride: b.props.labelOverride ?? null,
            dataJson: b.props.dataJson ?? null,
            controls: b.props.controls ?? [],
        })),
    };
}
