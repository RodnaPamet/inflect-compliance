/**
 * Sub-flow drill-down, driven from a tldraw editor.
 *
 * `canvas-drill-filter.ts` is the engine — since #3066 it is generic over the
 * node and edge types and names no renderer. This is the half that knows about
 * tldraw.
 *
 * ═══ THIS RUNS IN nodeKey SPACE, UNLIKE LAYOUT ═══
 *
 * `auto-layout-host.ts` deliberately works in SHAPE id space, because it WRITES
 * — `updateShapes` needs shape ids, and a drawn node's shape id is random.
 *
 * Drill-down only READS, and the thing it reads is a parent relationship the
 * ROW owns: `parentNodeKey` names a parent by key, not by shape id, and the
 * drill stack the user navigates holds those same keys. Translating to shape
 * ids and back would mean two lookups that can disagree, to answer a question
 * neither id space is better at.
 *
 * So: scope is computed over keys, and converted to shape ids exactly once, at
 * the boundary where tldraw needs them — `getShapeVisibility`.
 *
 * ═══ WHY VISIBILITY AND NOT A STORE EDIT ═══
 *
 * The xyflow canvas filters the array it hands to `<ReactFlow>`, so an
 * out-of-scope node simply is not rendered and nothing about the document
 * changes. tldraw's store IS the document, so the equivalent must not touch it:
 * deleting or moving shapes to express a view would be saved, and drilling into
 * a group would quietly rewrite the map.
 *
 * `getShapeVisibility` is tldraw's own answer — a pure predicate the editor
 * asks per shape, with no store write. The scope is therefore a VIEW, which is
 * what it always was on the other engine.
 */
import type { Editor } from 'tldraw';

import {
    buildDrillBreadcrumbs,
    filterByDrillScope,
    type DrillEdge,
    type DrillNode,
} from '@/lib/processes/canvas-drill-filter';
import { PROCESS_EDGE_BINDING_TYPE } from './process-edge-binding';
import { edgeKeyFromShapeId } from './process-edge-shape';
import { PROCESS_NODE_SHAPE_TYPE } from './process-node-shape';

/** The shape fields this module reads. Structural on purpose. */
interface StoreShape {
    id: string;
    type?: string;
    props?: {
        nodeKey?: unknown;
        parentNodeKey?: unknown;
        label?: unknown;
        nodeType?: unknown;
        dataJson?: unknown;
    };
}

/**
 * Is this group folded? (#3117)
 *
 * Pure and total, narrowing rather than casting, for the reason
 * `ruleIdFromDataJson` gives: `dataJson` is the opaque passthrough #2960
 * established, the server writes keys the client does not enumerate, and a row
 * whose `collapsed` is the STRING `"true"` must not fold a group — it is not
 * what this product wrote, so it is not a fold.
 *
 * `null` is a valid `dataJson` and `typeof null === 'object'`, which is why that
 * arm is explicit. It is also the overwhelmingly common case: every node on
 * every map today.
 */
export function isCollapsedFromDataJson(dataJson: unknown): boolean {
    if (typeof dataJson !== 'object' || dataJson === null) return false;
    return (dataJson as { collapsed?: unknown }).collapsed === true;
}

/**
 * The node keys hidden because an ANCESTOR group is folded (#3117).
 *
 * ═══ WHY THIS IS SEPARATE FROM THE DRILL SCOPE ═══
 *
 * Collapse and drill-down both hide nodes, and it is tempting to express the
 * first through the second — `visibleNodeKeys` already returns "the set of keys
 * that may be seen". That does not work, and the reason is worth stating because
 * it is not obvious:
 *
 * `visibleNodeKeys` returns NULL at root, and the visibility predicate reads
 * null as "no filtering at all". Collapse's main case IS at root — looking at
 * the whole map and folding one group away. Making the function return a set at
 * root instead would switch the predicate out of its null fast path, and that
 * path is what keeps stickies, frames and drawings visible: its non-process arm
 * returns `hidden` whenever a scope exists, because drilling in means "show me
 * this sub-process" and not the annotations about the whole map.
 *
 * So folding one group at root would have silently hidden every annotation on
 * the canvas. Two independent reasons to hide a node need two inputs, not one
 * overloaded one.
 *
 * ═══ THE GROUP ITSELF STAYS VISIBLE ═══
 *
 * Only DESCENDANTS are returned. The folded group is the thing the user clicks
 * to unfold, so hiding it would make the fold irreversible on the canvas.
 *
 * Transitive, by walking parents upward per node rather than descending from
 * each collapsed group: a node inside a group inside a folded group is hidden
 * too, and walking up visits each node once instead of re-walking shared
 * subtrees. The loop is bounded by the node count, so a `parentNodeKey` cycle
 * written by a bad client cannot hang the canvas.
 */
export function collapsedHiddenKeys(editor: Editor): Set<string> {
    const shapes = (editor.getCurrentPageShapes() as unknown as StoreShape[]).filter(
        (s) => s.type === PROCESS_NODE_SHAPE_TYPE,
    );

    const parentOf = new Map<string, string>();
    const collapsed = new Set<string>();
    for (const s of shapes) {
        const key = s.props?.nodeKey;
        if (typeof key !== 'string' || key.length === 0) continue;
        const parent = s.props?.parentNodeKey;
        if (typeof parent === 'string' && parent.length > 0) parentOf.set(key, parent);
        if (isCollapsedFromDataJson(s.props?.dataJson)) collapsed.add(key);
    }
    if (collapsed.size === 0) return new Set();

    const hidden = new Set<string>();
    for (const key of parentOf.keys()) {
        let cursor = parentOf.get(key);
        // Bounded by the node count: a cycle cannot spin forever, it just
        // stops without claiming an ancestor it never reached.
        for (let depth = 0; cursor !== undefined && depth <= parentOf.size; depth += 1) {
            if (collapsed.has(cursor)) {
                hidden.add(key);
                break;
            }
            cursor = parentOf.get(cursor);
        }
    }
    return hidden;
}

/**
 * Process nodes as the filter wants them, keyed by `nodeKey`.
 *
 * `parentId` is the filter's name for "the group this belongs to", and on a
 * tldraw shape that fact lives in `props.parentNodeKey`. Mapped here rather
 * than teaching the filter a second field name, which is what keeps the filter
 * ignorant of both renderers.
 *
 * Note this is NOT tldraw's own `parentId`. A tldraw shape has one of those
 * too — its page or its containing frame — and it means something unrelated.
 * Reading that by mistake would scope the canvas by frame membership and look
 * almost right on a map with no frames.
 */
export function drillNodesFrom(editor: Editor): DrillNode[] {
    return (editor.getCurrentPageShapes() as unknown as StoreShape[])
        .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE)
        .flatMap((s) => {
            const nodeKey = s.props?.nodeKey;
            if (typeof nodeKey !== 'string' || nodeKey.length === 0) return [];
            const parent = s.props?.parentNodeKey;
            return [
                {
                    id: nodeKey,
                    ...(typeof parent === 'string' && parent.length > 0
                        ? { parentId: parent }
                        : {}),
                    data: { label: s.props?.label },
                },
            ];
        });
}

/** Process edges as the filter wants them: endpoints by row key. */
export function drillEdgesFrom(editor: Editor): DrillEdge[] {
    return editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'binding' &&
                (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
        )
        .map((r) => {
            const b = r as unknown as { props: { sourceKey: string; targetKey: string } };
            return { source: b.props.sourceKey, target: b.props.targetKey };
        });
}

/**
 * The node keys visible at a given scope.
 *
 * `null` at root, and that is not the same as "every key": a caller that gets a
 * SET has to be given one for every node, and building it means walking the
 * page for a question whose answer is "no filtering". Returning null lets the
 * visibility predicate short-circuit to `inherit`, which is also what keeps
 * freeform annotation shapes untouched at root.
 */
export function visibleNodeKeys(editor: Editor, groupId: string | null): Set<string> | null {
    if (groupId === null) return null;
    const { visibleNodes } = filterByDrillScope(
        drillNodesFrom(editor),
        drillEdgesFrom(editor),
        groupId,
    );
    return new Set(visibleNodes.map((n) => n.id));
}

/** The breadcrumb trail for a drill stack, labelled from the live shapes. */
export function drillTrail(
    editor: Editor,
    stack: readonly string[],
    rootLabel?: string,
): Array<{ id: string | null; label: string }> {
    return buildDrillBreadcrumbs(stack, drillNodesFrom(editor), rootLabel);
}

/** What `getShapeVisibility` returns, mirrored so callers need no tldraw import. */
export type ShapeVisibility = 'hidden' | 'inherit' | 'visible';

/**
 * A `getShapeVisibility` predicate for a scope.
 *
 * Four kinds of record are on the page and each needs its own answer:
 *
 *   • a PROCESS NODE is visible iff its key is in scope;
 *   • an EDGE LINE is visible iff BOTH its endpoints are — a line to a hidden
 *     node is a line into empty space, which reads as a rendering fault rather
 *     than a scope;
 *   • anything ELSE — stickies, frames, drawings — is hidden while drilled in.
 *     That matches the other engine, where the filter returns only the group's
 *     children and the annotation layer simply is not in the array. Drilling in
 *     means "show me this sub-process", and an annotation about the whole map
 *     is not part of it.
 *   • at ROOT everything inherits, which is the no-filtering case.
 */
export function shapeVisibilityForScope(
    keys: Set<string> | null,
    edgeEndpointsByKey: ReadonlyMap<string, { source: string; target: string }>,
    hiddenByCollapse: ReadonlySet<string> = new Set(),
): (shape: { id: string; type?: string; props?: { nodeKey?: unknown } }) => ShapeVisibility {
    /*
        The fast path survives #3117, and it has to: at root with nothing folded
        the answer is still "no filtering", which is what keeps annotations on
        screen. Both conditions are required — `keys === null` alone would make a
        fold at root a no-op.
    */
    if (keys === null && hiddenByCollapse.size === 0) return () => 'inherit';

    /** In scope for the DRILL level. Null scope means every node is. */
    const inScope = (k: string) => keys === null || keys.has(k);
    /** Visible after both reasons are considered. */
    const shown = (k: string) => inScope(k) && !hiddenByCollapse.has(k);

    return (shape) => {
        if (shape.type === PROCESS_NODE_SHAPE_TYPE) {
            const k = shape.props?.nodeKey;
            return typeof k === 'string' && shown(k) ? 'inherit' : 'hidden';
        }
        const edgeKey = edgeKeyFromShapeId(shape.id);
        if (edgeKey !== null) {
            const ends = edgeEndpointsByKey.get(edgeKey);
            if (!ends) return 'hidden';
            // An edge into a folded node is a line into empty space, exactly as
            // it is for an out-of-scope node — one rule, both reasons.
            return shown(ends.source) && shown(ends.target) ? 'inherit' : 'hidden';
        }
        /*
            Annotations: hidden while DRILLED IN only. A fold is a statement
            about one group, not about the map, so folding a group at root must
            leave the sticky note beside it alone. This is the line that would
            have been wrong had collapse been expressed through the scope set.
        */
        return keys === null ? 'inherit' : 'hidden';
    };
}

/** `edgeKey → { source, target }`, for the visibility predicate's edge arm. */
export function edgeEndpointIndex(
    editor: Editor,
): Map<string, { source: string; target: string }> {
    const out = new Map<string, { source: string; target: string }>();
    for (const r of editor.store.allRecords()) {
        if (r.typeName !== 'binding') continue;
        if ((r as { type?: string }).type !== PROCESS_EDGE_BINDING_TYPE) continue;
        const b = r as unknown as {
            props: { edgeKey: string; sourceKey: string; targetKey: string };
        };
        out.set(b.props.edgeKey, { source: b.props.sourceKey, target: b.props.targetKey });
    }
    return out;
}
