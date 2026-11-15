/**
 * The process edge as a tldraw BINDING, not an arrow.
 *
 * ═══ WHY A BINDING AND NOT A FREEHAND ARROW ═══
 *
 * An arrow is a drawing between two points. A `ProcessEdge` is a row that other
 * things depend on: `ProcessEdgeControl` hangs off it — "the control sits on
 * the line between two steps" — and coverage reads those links. An edge that
 * were merely drawn would have nowhere to put a control and nothing for a
 * compliance query to find.
 *
 * So the edge carries the persisted fields as binding props, and `fromId` /
 * `toId` name the shapes at each end. #2960 states the rule the other way
 * round: edge→control links attach here, and that is *why* edges cannot be
 * arrows.
 *
 * ═══ KEYS, NOT SHAPE IDS, ARE THE CONTRACT ═══
 *
 * `sourceKey` and `targetKey` are `nodeKey` values and travel in props.
 * `fromId` / `toId` are tldraw's own wiring and are derived from those keys.
 *
 * They are not interchangeable: a shape the user drew has a random id whose
 * `nodeKey` is only in its props, so reading an endpoint off `fromId` would be
 * correct until the first node created by drawing it — the same trap the node
 * shape documents. The row is written from the KEYS.
 */
import { T, type Editor, type RecordProps, type TLBaseBinding, type TLShapeId } from 'tldraw';

import { PROCESS_NODE_SHAPE_TYPE } from './process-node-shape';

/** The discriminator. */
export const PROCESS_EDGE_BINDING_TYPE = 'process-edge' as const;

/** Mirrors `ProcessEdgeInput['controls']` — see schemas/process-map.ts. */
export type ProcessEdgeControlProp = {
    controlKey: string;
    label: string;
    controlId: string;
    dataJson: unknown;
};

export type ProcessEdgeBindingProps = {
    edgeKey: string;
    sourceKey: string;
    targetKey: string;
    /** `'flow'` unless something says otherwise; the wire default. */
    edgeKind: string;
    labelOverride: string | null;
    dataJson: unknown;
    /**
     * The controls sitting on this edge. Carried on the binding rather than
     * looked up, because they travel in the save payload with it — the
     * repository recreates them alongside the edge, so a binding that lost them
     * would silently drop control links on the next save.
     */
    controls: ProcessEdgeControlProp[];
};

export type ProcessEdgeBinding = TLBaseBinding<
    typeof PROCESS_EDGE_BINDING_TYPE,
    ProcessEdgeBindingProps
>;

export const processEdgeBindingProps: RecordProps<ProcessEdgeBinding> = {
    edgeKey: T.string,
    sourceKey: T.string,
    targetKey: T.string,
    edgeKind: T.string,
    labelOverride: T.string.nullable(),
    dataJson: T.jsonValue,
    controls: T.arrayOf(
        T.object({
            controlKey: T.string,
            label: T.string,
            controlId: T.string,
            dataJson: T.jsonValue,
        }),
    ),
};

/**
 * A binding's endpoints as node keys, read through the shapes it binds.
 *
 * The same resolution `tldrawToRows` applies on save: each end's `nodeKey`
 * from the shape `fromId` / `toId` names, and the stored `sourceKey` /
 * `targetKey` only when that shape is not a process node on this page.
 *
 * Every live reader of an edge's endpoints goes through this (#5309 item 24).
 * The props are a denormalised copy and can be stale: tldraw's Duplicate copied
 * a binding between two copied steps with their ORIGINALS' keys, so a reader of
 * the props saw `A→B` where the save saw `A'→B'`. The arrow converter's
 * duplicate check then let a second `A'→B'` through, and every save after it
 * refused `DUPLICATE_EDGE`.
 */
export function edgeEndpointKeys(
    editor: Pick<Editor, 'getShape'>,
    binding: { fromId: string; toId: string; props: { sourceKey: string; targetKey: string } },
): { sourceKey: string; targetKey: string } {
    const keyOf = (shapeId: string): string | null => {
        const s = editor.getShape(shapeId as TLShapeId) as
            | { type?: string; props?: { nodeKey?: unknown } }
            | undefined;
        if (!s || s.type !== PROCESS_NODE_SHAPE_TYPE) return null;
        return typeof s.props?.nodeKey === 'string' ? s.props.nodeKey : null;
    };
    return {
        sourceKey: keyOf(binding.fromId) ?? binding.props.sourceKey,
        targetKey: keyOf(binding.toId) ?? binding.props.targetKey,
    };
}

/** The wire default for `edgeKind`, so nothing has to copy the literal. */
export const DEFAULT_EDGE_KIND = 'flow';

/**
 * The maximum controls one edge may carry.
 *
 * Mirrors `.max(64)` on `ProcessEdgeInputSchema.controls`. Exported for the
 * same reason the graph ceilings are: a client that wants to refuse a 65th
 * control before the server does has to know the number, and a hand-copied
 * limit drifts permissive — the copy keeps allowing while the server rejects,
 * so the user meets the ceiling as a 400 after the work is done.
 */
export const MAX_CONTROLS_PER_EDGE = 64;
