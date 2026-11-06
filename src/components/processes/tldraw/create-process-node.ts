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
 */
import type { Editor, TLShapeId } from 'tldraw';

import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_SHAPE_TYPE,
    shapeIdForNodeKey,
} from './process-node-shape';
import { PROCESS_EDGE_BINDING_TYPE } from './process-edge-binding';
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

/**
 * Re-mint a step's or an edge's key when a shape or binding is created
 * carrying a key another record already holds. Returns the disposer.
 */
export function installUniqueProcessKeys(editor: Editor): () => void {
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
        const key = (binding.props as { edgeKey?: unknown }).edgeKey;
        if (typeof key !== 'string') return binding;
        const clash = editor.store
            .allRecords()
            .some(
                (r) =>
                    r.typeName === 'binding' &&
                    r.id !== binding.id &&
                    (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE &&
                    (r as { props?: { edgeKey?: unknown } }).props?.edgeKey === key,
            );
        if (!clash) return binding;
        return { ...binding, props: { ...binding.props, edgeKey: mintEdgeKey() } } as typeof binding;
    });
    return () => {
        offShape();
        offBinding();
    };
}
