/**
 * The process node as a tldraw shape — its type, its props, and the mapping
 * between a shape id and the `nodeKey` that identifies the row.
 *
 * ═══ PROPS CARRY EXACTLY THE PERSISTED FIELDS ═══
 *
 * `x`/`y` are deliberately ABSENT. They live on the tldraw shape itself and map
 * to `ProcessNode.posX`/`posY`, and that is the only home position has —
 * duplicating it into `dataJson` would create two sources that drift, and the
 * one the renderer moves is not the one a diff would read.
 *
 * `dataJson` is an opaque passthrough. The server writes keys the client does
 * not know about, so it is validated as "any JSON value" and never destructured
 * here. Reading it would make this file a consumer of a forward-compatibility
 * slot that exists precisely so it has none.
 *
 * ═══ WHY `nodeKey` IS IN PROPS AS WELL AS IN THE ID ═══
 *
 * #2959 proved `createShapeId(nodeKey)` is deterministic and losslessly
 * reversible, so a shape loaded FROM a row could carry its key in the id alone.
 * A shape the user DRAWS cannot: tldraw mints a random id for it, and its
 * `nodeKey` has to be minted separately before it is ever saved.
 *
 * So props hold the authority and the id is a fast lookup derived from it. The
 * two agree for every shape that came from a row, and only props is meaningful
 * for one that did not. Reading the key off the id would be correct until the
 * first node somebody created by drawing it.
 */
import { T, type RecordProps, type TLBaseShape, createShapeId } from 'tldraw';

import { PROCESS_STEP_NODE_TYPE } from '@/components/processes/node-taxonomy';

/** The discriminator. A shape is a process node only if it says so. */
export const PROCESS_NODE_SHAPE_TYPE = 'process-node' as const;

export type ProcessNodeShapeProps = {
    w: number;
    h: number;
    nodeKey: string;
    /**
     * A `ProcessNodeKind` in practice, but typed and validated as a plain
     * string on purpose: the wire schema is `z.string().min(1).max(64)`, so a
     * row may legitimately carry a kind this build has never heard of — an
     * older map, or a newer client. The renderer degrades; it does not refuse.
     */
    nodeType: string;
    label: string;
    subtitle: string | null;
    parentNodeKey: string | null;
    dataJson: unknown;
};

export type ProcessNodeShape = TLBaseShape<
    typeof PROCESS_NODE_SHAPE_TYPE,
    ProcessNodeShapeProps
>;

/**
 * Runtime validators, which are NOT the same claim as the types above.
 *
 * A shape can arrive from a stored document rather than from this build's
 * code — a map saved by an older client, or a hand-edited snapshot — so the
 * types say what we intend and these say what tldraw will accept.
 */
export const processNodeShapeProps: RecordProps<ProcessNodeShape> = {
    w: T.nonZeroNumber,
    h: T.nonZeroNumber,
    nodeKey: T.string,
    nodeType: T.string,
    label: T.string,
    subtitle: T.string.nullable(),
    parentNodeKey: T.string.nullable(),
    // Opaque by contract: anything JSON-serialisable, inspected by nobody.
    dataJson: T.jsonValue,
};

/** Default geometry for a freshly created node. */
/**
 * The kind a node falls back to.
 *
 * Now the REAL constant rather than a copy of its value. This used to read
 * `= 'processStep'` with a comment explaining that importing
 * `PROCESS_STEP_NODE_TYPE` was impossible: it was declared in
 * `ProcessTypedNode.tsx`, the xyflow renderer phase 4 deletes, so importing it
 * would have made the tldraw canvas depend on the component it replaces.
 *
 * That constant has since moved to `node-taxonomy.ts`, which is engine-free and
 * survives the cutover, so the duplication has no reason left. The local name
 * stays because it says something the canonical one does not — this is the
 * FALLBACK, the kind chosen when a drag payload names none.
 */
export const PROCESS_NODE_FALLBACK_KIND = PROCESS_STEP_NODE_TYPE;

export const PROCESS_NODE_DEFAULT_W = 220;
export const PROCESS_NODE_DEFAULT_H = 88;

/** The prefix `createShapeId` stamps. Derived, never hardcoded in logic. */
const SHAPE_PREFIX = String(createShapeId(''));

/**
 * `nodeKey` → the shape id it always produces.
 *
 * Deterministic, so a load/save cycle with no user edit reproduces the same
 * ids and a diff shows nothing changed. #2959 measured this rather than
 * assuming it, and `tests/unit/processes/process-node-shape.test.ts` keeps
 * measuring it.
 */
export function shapeIdForNodeKey(nodeKey: string): string {
    return String(createShapeId(nodeKey));
}

/**
 * The inverse, for a shape that came from a row.
 *
 * Returns null for an id this mapping did not produce — a shape the user drew,
 * whose id is random. A caller that needs the key of such a shape must read
 * `props.nodeKey`, which is why that prop exists.
 */
export function nodeKeyFromShapeId(shapeId: string): string | null {
    if (!shapeId.startsWith(SHAPE_PREFIX)) return null;
    const rest = shapeId.slice(SHAPE_PREFIX.length);
    return rest.length > 0 ? rest : null;
}
