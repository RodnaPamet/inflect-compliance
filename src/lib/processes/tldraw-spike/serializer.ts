/**
 * SPIKE ONLY — #2959 phase 1. Not wired to anything, never merged.
 *
 * The bidirectional projection between the persisted process graph and a
 * tldraw store snapshot. The phase exists to answer ONE question:
 *
 *     is `rowsToTldraw(tldrawToRows(store))` EXACT?
 *
 * If a load/save cycle with no user edit does not produce an identical row
 * set, autosave writes spurious versions forever and every diff becomes noise.
 * Everything downstream assumes it holds.
 *
 * ═══ WHY THE SHAPE IDS ARE NOT BOOKKEEPING ═══
 *
 * `createShapeId(id?: string)` accepts a caller-supplied id, so a shape's id is
 * `shape:${nodeKey}` and reversing it is stripping a fixed prefix. The plan
 * assumed tldraw would mint its own ids and told us to hold the mapping in
 * shape `meta`; that is not needed. The mapping is the identity function, which
 * makes key stability structural rather than something to maintain.
 *
 * `createShapeId()` with NO argument is random. So the property worth guarding
 * is "the key is always passed", not "the mapping is correct".
 *
 * ═══ CONTROLS RIDE WITH THE EDGE, AND THAT IS LOAD-BEARING ═══
 *
 * `ProcessEdgeInputSchema.controls` defaults to `[]`, and the repository
 * recreates `ProcessEdgeControl` rows only from what the payload carries. A
 * projection that dropped them would validate cleanly and silently delete every
 * edge->control link in the map. They are carried here deliberately, and the
 * round-trip test compares them.
 */
import { createShapeId } from '@tldraw/tlschema';

import type {
    ProcessNodeInput,
    ProcessEdgeInput,
} from '@/app-layer/schemas/process-map';

/** The prefix `createShapeId` stamps. Derived, never hardcoded in logic below. */
const SHAPE_PREFIX = 'shape:';

/** What a save accepts — the projection's target, by the real type. */
export interface GraphRows {
    nodes: ProcessNodeInput[];
    edges: ProcessEdgeInput[];
}

/**
 * A process node as a tldraw shape.
 *
 * Props carry exactly the persisted fields. `x`/`y` are tldraw's own geometry
 * and are the ONLY home for position — duplicating it into `dataJson` would
 * create two sources that drift.
 */
export interface ProcessShape {
    id: string;
    type: 'process-node';
    x: number;
    y: number;
    props: {
        nodeKey: string;
        nodeType: string;
        label: string;
        subtitle: string | null;
        parentNodeKey: string | null;
        dataJson: unknown;
    };
}

/** A process edge as a tldraw binding between two shapes. */
export interface ProcessBinding {
    id: string;
    type: 'process-edge';
    fromId: string;
    toId: string;
    props: {
        edgeKey: string;
        sourceKey: string;
        targetKey: string;
        edgeKind: string;
        labelOverride: string | null;
        dataJson: unknown;
        controls: ProcessEdgeInput['controls'];
    };
}

/**
 * Anything on the canvas that is NOT a process node.
 *
 * Sticky notes, freehand, text — tldraw's native shapes, and a reason to
 * switch. Modelled as opaque on purpose: the projection must be able to carry
 * them without understanding them, because the moment it understands them
 * somebody will be tempted to derive something from one.
 */
export interface FreeformShape {
    id: string;
    type: string;
    [k: string]: unknown;
}

export interface TldrawGraph {
    shapes: ProcessShape[];
    bindings: ProcessBinding[];
    /**
     * Persisted SEPARATELY from the structured graph (§2, "allow freeform, but
     * keep it separate"). These never become `ProcessNode` rows, so a sticky
     * note cannot appear in a coverage report.
     */
    freeform: FreeformShape[];
}

/** The discriminator. A shape is a process node only if it says so. */
export const PROCESS_SHAPE_TYPE = 'process-node';

export function isProcessShape(s: { type: string }): boolean {
    return s.type === PROCESS_SHAPE_TYPE;
}

/**
 * Raised when a binding names a node the graph does not contain.
 *
 * §2.4 asks for this client-side: "an edge referencing an unknown nodeKey is
 * rejected. The user should find out at draw time, not at save time." The
 * repository enforces it server-side already — this is the same rule said
 * earlier, not a new one, and the message names both ends because neither
 * alone tells the user which arrow to look at.
 */
export class UnknownNodeKeyError extends Error {
    constructor(readonly edgeKey: string, readonly missing: string[]) {
        super(
            `Edge "${edgeKey}" references ${missing.length === 1 ? 'a node' : 'nodes'} ` +
                `that do not exist on this map: ${missing.join(', ')}.`,
        );
        this.name = 'UnknownNodeKeyError';
    }
}

/** `nodeKey` -> the tldraw shape id it always produces. */
export function shapeIdFor(nodeKey: string): string {
    return String(createShapeId(nodeKey));
}

/** The inverse. Total, because the prefix is fixed and we always supply the key. */
export function nodeKeyFor(shapeId: string): string {
    return shapeId.startsWith(SHAPE_PREFIX) ? shapeId.slice(SHAPE_PREFIX.length) : shapeId;
}

export function rowsToTldraw(rows: GraphRows, freeform: FreeformShape[] = []): TldrawGraph {
    return {
        freeform,
        shapes: rows.nodes.map((n) => ({
            id: shapeIdFor(n.nodeKey),
            type: 'process-node' as const,
            x: n.posX,
            y: n.posY,
            props: {
                nodeKey: n.nodeKey,
                nodeType: n.nodeType,
                label: n.label,
                // `?? null` on both sides of the projection: the schema admits
                // `undefined` and `null` and the row stores `null`. Normalising
                // in ONE direction only is how a round-trip acquires a
                // difference that is invisible to read but not to `toEqual`.
                subtitle: n.subtitle ?? null,
                parentNodeKey: n.parentNodeKey ?? null,
                dataJson: n.dataJson ?? null,
            },
        })),
        bindings: rows.edges.map((e) => ({
            id: `binding:${e.edgeKey}`,
            type: 'process-edge' as const,
            fromId: shapeIdFor(e.sourceKey),
            toId: shapeIdFor(e.targetKey),
            props: {
                edgeKey: e.edgeKey,
                sourceKey: e.sourceKey,
                targetKey: e.targetKey,
                edgeKind: e.edgeKind,
                labelOverride: e.labelOverride ?? null,
                dataJson: e.dataJson ?? null,
                controls: e.controls ?? [],
            },
        })),
    };
}

export function tldrawToRows(graph: TldrawGraph): GraphRows {
    // ONLY process shapes become rows. `graph.shapes` is typed as process
    // shapes, but a real store hands back everything on the canvas, so the
    // filter is the contract rather than a formality — and the test for it
    // feeds in a sticky note.
    const processShapes = graph.shapes.filter(isProcessShape);
    const known = new Set(processShapes.map((s) => s.props.nodeKey));

    for (const b of graph.bindings) {
        const missing = [nodeKeyFor(b.fromId), nodeKeyFor(b.toId)].filter((k) => !known.has(k));
        if (missing.length > 0) throw new UnknownNodeKeyError(b.props.edgeKey, missing);
    }

    return {
        nodes: processShapes.map((s) => ({
            nodeKey: s.props.nodeKey,
            nodeType: s.props.nodeType,
            label: s.props.label,
            subtitle: s.props.subtitle,
            // GEOMETRY COMES FROM THE SHAPE, not from props. If a user drags a
            // node, tldraw updates x/y and nothing else — reading position from
            // anywhere but here would silently discard the move.
            posX: s.x,
            posY: s.y,
            parentNodeKey: s.props.parentNodeKey,
            dataJson: s.props.dataJson,
        })),
        edges: graph.bindings.map((b) => ({
            edgeKey: b.props.edgeKey,
            // Read off the BINDING endpoints, not the stored copy. The endpoints
            // are what a user edits by re-attaching an arrow; `props.sourceKey`
            // is a denormalised convenience and would go stale the moment one
            // is moved.
            sourceKey: nodeKeyFor(b.fromId),
            targetKey: nodeKeyFor(b.toId),
            edgeKind: b.props.edgeKind,
            labelOverride: b.props.labelOverride,
            dataJson: b.props.dataJson,
            controls: b.props.controls,
        })),
    };
}
