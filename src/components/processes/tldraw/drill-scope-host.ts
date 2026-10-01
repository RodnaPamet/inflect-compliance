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
    props?: { nodeKey?: unknown; parentNodeKey?: unknown; label?: unknown };
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
): (shape: { id: string; type?: string; props?: { nodeKey?: unknown } }) => ShapeVisibility {
    if (keys === null) return () => 'inherit';
    return (shape) => {
        if (shape.type === PROCESS_NODE_SHAPE_TYPE) {
            const k = shape.props?.nodeKey;
            return typeof k === 'string' && keys.has(k) ? 'inherit' : 'hidden';
        }
        const edgeKey = edgeKeyFromShapeId(shape.id);
        if (edgeKey !== null) {
            const ends = edgeEndpointsByKey.get(edgeKey);
            if (!ends) return 'hidden';
            return keys.has(ends.source) && keys.has(ends.target) ? 'inherit' : 'hidden';
        }
        return 'hidden';
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
