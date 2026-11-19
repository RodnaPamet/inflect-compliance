/**
 * Creating a process step on the tldraw canvas, and keeping step keys unique.
 *
 * ═══ ONE CREATION PATH ═══
 *
 * A step reaches the canvas two ways: dragged from the palette onto a point,
 * or clicked in the palette and placed at the middle of the view. Both build
 * the same shape here, so a fix to what a new step carries (its parent while
 * drilled into a group, its default geometry) cannot reach one and miss the
 * other.
 *
 * ═══ WHY A NEW STEP TAKES THE OPEN GROUP AS ITS PARENT ═══
 *
 * While the user is drilled into a group, the canvas shows only the nodes
 * whose `parentNodeKey` is that group (`filterByDrillScope`). A step created
 * there with no parent was hidden the moment it was created: the drop worked
 * and the user saw nothing.
 *
 * ═══ WHY KEYS ARE RE-MINTED ON CREATE ═══
 *
 * `ProcessNode` is unique on `(processMapId, nodeKey)` and `ProcessEdge` on
 * `(processMapId, edgeKey)`. tldraw's own Duplicate (Ctrl+D, the menu, an
 * Alt-drag) and paste copy a shape's props verbatim, so a duplicated step
 * carried its source's `nodeKey`, and every save after it failed on the unique
 * index. The copy gets a fresh key at creation instead, and so does a copied
 * edge binding.
 *
 * ═══ AND A COPIED EDGE IS REWIRED TO ITS COPIES (#5309 item 24) ═══
 *
 * Re-minting the step keys left the copied binding between them naming the
 * ORIGINALS in `sourceKey` / `targetKey`, and with no line of its own. The
 * copies looked unconnected, so the user drew the edge again; the arrow
 * converter read the copy as `A→B`, let a second `A'→B'` through, and every
 * save after that refused `DUPLICATE_EDGE`. So a created binding takes its
 * endpoint keys from the shapes it binds, and a binding created outside the
 * load and arrow paths gets its derived line once the operation completes. A
 * copied LINE is removed: a line is derived from its binding and is only ever
 * at `shapeIdForEdgeKey(edgeKey)`, so a copy anywhere else is a stray drawing.
 */
import type { Editor, TLBindingId, TLShapeId } from 'tldraw';

import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_SHAPE_TYPE,
    shapeIdForNodeKey,
} from './process-node-shape';
import {
    PROCESS_EDGE_BINDING_TYPE,
    edgeEndpointKeys,
    type ProcessEdgeBinding,
} from './process-edge-binding';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeLineGeometry,
    shapeIdForEdgeKey,
} from './process-edge-shape';
import { mintEdgeKey } from './arrow-to-edge';

/**
 * A fresh `nodeKey` for a node the user creates.
 *
 * Two creations inside one millisecond must not share a key, because the row
 * is keyed on it: the random suffix is for distinctness, not unguessability.
 */
export function mintNodeKey(): string {
    return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface CreateProcessNodeInput {
    /** A `ProcessNodeKind`, already validated by the caller. */
    kind: string;
    label: string;
    /** Page coordinates of the node's top-left corner. */
    point: { x: number; y: number };
    /** The group the canvas is drilled into, or null at root. */
    parentNodeKey: string | null;
}

/** Create one process step and return its shape id. */
export function createProcessNode(editor: Editor, input: CreateProcessNodeInput): TLShapeId {
    const nodeKey = mintNodeKey();
    const id = shapeIdForNodeKey(nodeKey) as TLShapeId;
    editor.createShapes([
        {
            id,
            type: PROCESS_NODE_SHAPE_TYPE,
            x: input.point.x,
            y: input.point.y,
            props: {
                w: PROCESS_NODE_DEFAULT_W,
                h: PROCESS_NODE_DEFAULT_H,
                nodeKey,
                nodeType: input.kind,
                label: input.label,
                subtitle: null,
                parentNodeKey: input.parentNodeKey,
                dataJson: null,
                // A new control node starts unlinked; the inspector links it.
                controlId: null,
            },
        },
    ]);
    return id;
}

/**
 * Where a clicked palette item lands: centred in the current view, nudged
 * down-right while that spot is already taken, so clicking the same item twice
 * gives two visible steps rather than one stacked on the other.
 */
export function placementForClick(editor: Editor): { x: number; y: number } {
    const view = editor.getViewportPageBounds();
    const base = {
        x: view.x + view.w / 2 - PROCESS_NODE_DEFAULT_W / 2,
        y: view.y + view.h / 2 - PROCESS_NODE_DEFAULT_H / 2,
    };
    const taken = editor
        .getCurrentPageShapes()
        .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE)
        .map((s) => `${Math.round(s.x)}:${Math.round(s.y)}`);
    const occupied = new Set(taken);
    const point = { ...base };
    for (let i = 0; i < 50 && occupied.has(`${Math.round(point.x)}:${Math.round(point.y)}`); i++) {
        point.x += 24;
        point.y += 24;
    }
    return point;
}

export interface UniqueProcessKeysOptions {
    /**
     * The chip text for an edge's line, as the load path resolves it — label
     * and controls win over the chip. Injected because the text is localised;
     * omitted, a copied line has no chip until the next load.
     */
    resolveChipLabel?: (edgeKind: string, labelOverride: unknown, controls: unknown) => string;
}

/**
 * Re-mint a step's or an edge's key when a shape or binding is created
 * carrying a key another record already holds, rewire a created edge binding to
 * the steps it binds, and give it its line. Returns the disposer.
 *
 * Installed after the load's seeding, so the load path never reaches it.
 */
export function installUniqueProcessKeys(
    editor: Editor,
    opts: UniqueProcessKeysOptions = {},
): () => void {
    /** Edge bindings created since the last completed operation. */
    const createdBindings = new Set<string>();
    /** Lines created since the last completed operation, checked for copies. */
    const createdLines = new Set<string>();

    const offShape = editor.sideEffects.registerBeforeCreateHandler('shape', (shape) => {
        if (shape.type !== PROCESS_NODE_SHAPE_TYPE) return shape;
        const props = shape.props as { nodeKey?: unknown };
        const key = props.nodeKey;
        if (typeof key !== 'string') return shape;
        const clash = editor
            .getCurrentPageShapes()
            .some(
                (s) =>
                    s.id !== shape.id &&
                    s.type === PROCESS_NODE_SHAPE_TYPE &&
                    (s.props as { nodeKey?: unknown }).nodeKey === key,
            );
        if (!clash) return shape;
        return { ...shape, props: { ...shape.props, nodeKey: mintNodeKey() } } as typeof shape;
    });
    const offBinding = editor.sideEffects.registerBeforeCreateHandler('binding', (binding) => {
        if (binding.type !== PROCESS_EDGE_BINDING_TYPE) return binding;
        const props = binding.props as { edgeKey?: unknown; sourceKey: string; targetKey: string };
        // The endpoint keys from the shapes bound, whose own keys were
        // re-minted above when they were copied. Unchanged for a drawn edge,
        // whose converter already read them from the same shapes.
        const ends = edgeEndpointKeys(editor, binding as unknown as ProcessEdgeBinding);
        const key = props.edgeKey;
        const clash =
            typeof key === 'string' &&
            editor.store
                .allRecords()
                .some(
                    (r) =>
                        r.typeName === 'binding' &&
                        r.id !== binding.id &&
                        (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE &&
                        (r as { props?: { edgeKey?: unknown } }).props?.edgeKey === key,
                );
        if (!clash && ends.sourceKey === props.sourceKey && ends.targetKey === props.targetKey) {
            return binding;
        }
        return {
            ...binding,
            props: {
                ...binding.props,
                ...ends,
                ...(clash ? { edgeKey: mintEdgeKey() } : {}),
            },
        } as typeof binding;
    });
    const offBindingCreated = editor.sideEffects.registerAfterCreateHandler('binding', (binding) => {
        if (binding.type === PROCESS_EDGE_BINDING_TYPE) createdBindings.add(binding.id);
    });
    const offLineCreated = editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
        if (shape.type === PROCESS_EDGE_SHAPE_TYPE) createdLines.add(shape.id);
    });

    /**
     * Lines, once the operation that created the bindings is over.
     *
     * Not in the after-create handler: the arrow converter creates its binding
     * and then its line inside one `run`, so a line created at binding time
     * would collide with the converter's. By the time the operation completes
     * the converter's line exists and this does nothing, which is what keeps
     * the arrow path unchanged.
     */
    const offComplete = editor.sideEffects.registerOperationCompleteHandler(() => {
        if (createdBindings.size === 0 && createdLines.size === 0) return;
        const bindingIds = [...createdBindings];
        const lineIds = [...createdLines];
        createdBindings.clear();
        createdLines.clear();

        const strays = lineIds.flatMap((id) => {
            const line = editor.getShape(id as TLShapeId) as
                | { id: string; props?: { edgeKey?: unknown } }
                | undefined;
            if (!line) return [];
            const edgeKey = line.props?.edgeKey;
            return typeof edgeKey === 'string' && line.id === shapeIdForEdgeKey(edgeKey)
                ? []
                : [line.id as TLShapeId];
        });

        const lines = bindingIds.flatMap((id) => {
            const b = editor.getBinding(id as TLBindingId) as unknown as ProcessEdgeBinding | undefined;
            if (!b) return [];
            const lineId = shapeIdForEdgeKey(b.props.edgeKey);
            if (editor.getShape(lineId)) return [];
            const from = editor.getShapePageBounds(b.fromId);
            const to = editor.getShapePageBounds(b.toId);
            // No bounds: an endpoint not on this page. Skipped, as the load
            // path skips it, rather than drawn from the origin.
            if (!from || !to) return [];
            const g = edgeLineGeometry(from, to);
            return [
                {
                    id: lineId,
                    type: PROCESS_EDGE_SHAPE_TYPE,
                    x: g.x,
                    y: g.y,
                    props: {
                        edgeKey: b.props.edgeKey,
                        edgeKind: b.props.edgeKind,
                        label: b.props.labelOverride ?? '',
                        chipLabel:
                            opts.resolveChipLabel?.(
                                b.props.edgeKind,
                                b.props.labelOverride,
                                b.props.controls,
                            ) ?? '',
                        dx: g.dx,
                        dy: g.dy,
                    },
                },
            ];
        });
        if (strays.length === 0 && lines.length === 0) return;

        // In a `run`, so the writes join the undo entry of the duplicate or
        // paste that caused them — see `arrow-to-edge.ts` on loose writes from
        // a side-effect handler never reaching the undo stack.
        editor.run(
            () => {
                if (strays.length > 0) editor.deleteShapes(strays);
                if (lines.length > 0) editor.createShapes(lines as never);
            },
            { history: 'record' },
        );
    });

    return () => {
        offShape();
        offBinding();
        offBindingCreated();
        offLineCreated();
        offComplete();
        createdBindings.clear();
        createdLines.clear();
    };
}
