/**
 * Auto-layout, driven from a tldraw editor.
 *
 * `canvas-auto-layout.ts` is the engine — dagre for the two hierarchical
 * directions, elk for the force-directed one — and since #3063 it names no
 * renderer: it reads `id`, `position`, `data.kind` and an optional measured
 * size, and returns a `positions` map. This is the half that knows about
 * tldraw.
 *
 * ── Why the host is a separate module ────────────────────────────────
 *
 * The engine is pure and already tested against both shapes of input. What is
 * NOT tested by any of that is the translation: reading process nodes out of a
 * store, deciding what counts as an edge for layout purposes, and writing
 * positions back. Those are where a port goes wrong, and keeping them here
 * means they can be tested against a real store without a mounted React tree.
 *
 * ── The id space is tldraw's, not the row's ──────────────────────────
 *
 * Layout runs on SHAPE ids, not `nodeKey`s. Two reasons, and the second is the
 * one that bites: `editor.updateShapes` needs shape ids to write back, and a
 * node the user DREW has a random shape id whose `nodeKey` lives only in its
 * props — so a `nodeKey`-keyed round trip would silently skip every freshly
 * drawn node. The same trap `use-tldraw-selection` documents.
 *
 * Edges therefore have to be expressed in shape ids too, which means resolving
 * each binding's `sourceKey` / `targetKey` back to the shape carrying it.
 */
import type { Editor, TLShapeId } from 'tldraw';

import {
    computeAutoLayout,
    computeForceLayout,
    type AutoLayoutDirection,
    type LayoutEdge,
    type LayoutNode,
} from '@/lib/processes/canvas-auto-layout';
import { PROCESS_EDGE_BINDING_TYPE } from './process-edge-binding';
import { PROCESS_NODE_SHAPE_TYPE } from './process-node-shape';

/** The subset of a tldraw shape this module reads. Structural on purpose. */
interface StoreShape {
    id: string;
    type?: string;
    x: number;
    y: number;
    props?: { nodeKey?: unknown; nodeType?: unknown; w?: unknown; h?: unknown };
}

/** Every process node on the current page, as the engine wants it. */
export function layoutNodesFrom(editor: Editor): LayoutNode[] {
    return (editor.getCurrentPageShapes() as unknown as StoreShape[])
        .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE)
        .map((s) => ({
            id: s.id,
            position: { x: s.x, y: s.y },
            // `nodeType` is where the kind lives on a tldraw shape; the engine
            // reads `data.kind` and skips `annotation`. Mapping it here rather
            // than teaching the engine a second field name keeps the engine
            // ignorant of both renderers, which is the point of #3063.
            data: { kind: s.props?.nodeType },
            // tldraw shapes carry explicit `w`/`h` props rather than a measured
            // box, and the node shape's are authoritative because it refuses
            // resize. Passed through `style` because that is the engine's name
            // for "the host knows a size".
            style: { width: s.props?.w, height: s.props?.h },
        }));
}

/**
 * Every process edge on the current page, in SHAPE id space.
 *
 * A binding names its endpoints twice: structurally as `fromId` / `toId`
 * (tldraw shape ids) and semantically as `sourceKey` / `targetKey` (row keys).
 * The structural pair is used, because that is already the id space layout
 * runs in — resolving the keys back to shapes would be a second lookup that
 * can disagree with the first.
 *
 * Bindings whose endpoints are not both on the page are DROPPED rather than
 * half-applied: dagre given an edge to an unknown node invents a rank for it
 * and shifts everything else to accommodate a node nobody can see.
 */
export function layoutEdgesFrom(editor: Editor): LayoutEdge[] {
    const onPage = new Set(editor.getCurrentPageShapes().map((s) => String(s.id)));
    return editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'binding' &&
                (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
        )
        .map((r) => r as unknown as { id: string; fromId: string; toId: string })
        .filter((b) => onPage.has(b.fromId) && onPage.has(b.toId))
        .map((b) => ({ id: b.id, source: b.fromId, target: b.toId }));
}

/** Shape ids of the current selection that are process nodes. */
export function selectedNodeIds(editor: Editor): Set<string> {
    return new Set(
        (editor.getSelectedShapes() as unknown as StoreShape[])
            .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE)
            .map((s) => s.id),
    );
}

/**
 * Write a positions map back onto the shapes it names.
 *
 * ONE `updateShapes` call rather than a loop of `updateShape`: a thirty-node
 * layout applied one shape at a time is thirty store operations, each firing
 * the binding hooks that reposition every attached edge line. The lines settle
 * to the same place either way; the difference is thirty repaints and thirty
 * undo steps.
 *
 * NO explicit history mark. I wrote one, with a comment claiming it collapsed
 * the layout into a single undo entry, and the mutation proof disagreed:
 * removing it left all thirteen tests green, including the one that undoes a
 * layout in a single step. tldraw records store operations itself, so a single
 * batched call is already one entry.
 *
 * This is the SECOND time that line has been written and removed in this
 * subsystem — `TldrawProcessCanvas`'s drop handler carries the same note, from
 * the same measurement. The reflex comes from the xyflow canvas, where the drop
 * handler genuinely had to call `history.push`.
 */
export function applyLayout(
    editor: Editor,
    positions: Record<string, { x: number; y: number }>,
): number {
    const updates = Object.entries(positions).map(([id, p]) => ({
        id: id as TLShapeId,
        type: PROCESS_NODE_SHAPE_TYPE,
        x: p.x,
        y: p.y,
    }));
    if (updates.length === 0) return 0;
    editor.updateShapes(updates as never);
    return updates.length;
}

export type AutoLayoutScope = 'all' | 'selection';

/**
 * Lay the graph out and apply the result.
 *
 * Returns how many nodes moved, so a caller can tell "nothing to do" from
 * "done" without re-reading the store. Zero is a legitimate answer: an empty
 * map, or a selection of fewer than two nodes.
 */
export function runAutoLayout(
    editor: Editor,
    direction: AutoLayoutDirection,
    scope: AutoLayoutScope = 'all',
): number {
    const filter = scope === 'selection' ? selectedNodeIds(editor) : undefined;
    // Fewer than two selected nodes cannot be arranged RELATIVE to anything,
    // and laying out one node moves it to the origin of its own private graph —
    // which looks like the node being flung away.
    if (filter && filter.size < 2) return 0;
    const { positions } = computeAutoLayout(
        layoutNodesFrom(editor),
        layoutEdgesFrom(editor),
        direction,
        filter,
    );
    return applyLayout(editor, positions);
}

/**
 * The force-directed variant. Async because elk is loaded on demand — the
 * bundle is large and most sessions never ask for this layout.
 */
export async function runForceLayout(
    editor: Editor,
    scope: AutoLayoutScope = 'all',
): Promise<number> {
    const filter = scope === 'selection' ? selectedNodeIds(editor) : undefined;
    if (filter && filter.size < 2) return 0;
    const { positions } = await computeForceLayout(
        layoutNodesFrom(editor),
        layoutEdgesFrom(editor),
        filter,
    );
    return applyLayout(editor, positions);
}
