'use client';

/**
 * The tldraw process canvas — READ-ONLY, and deliberately so.
 *
 * ═══ WHAT THIS IS AND IS NOT ═══
 *
 * #2961's surface swap, first slice. This mounts a tldraw editor, seeds it from
 * `ProcessNode` / `ProcessEdge` rows through the serializer, and stops there.
 *
 * It carries **no write path at all**: no autosave, no history, no
 * `expectedVersion`, no inspector wiring, and the editor is put into read-only
 * mode so nothing can be edited into a store nobody saves. That is not an
 * unfinished half — it is the reviewable unit. The whole risk of this migration
 * lives in the write direction (`tldrawToRows` → `save()` →
 * optimistic concurrency), and none of it can be reasoned about until the read
 * direction is known to work. So the read direction ships first, on its own,
 * where it changes nothing for any tenant.
 *
 * NOTHING MOUNTS THIS YET. `isProcessCanvasTldrawEnabled` (#2996) has zero
 * consumers and still does after this file — wiring the flag is the next slice,
 * so that "which renderer" and "does the renderer work" stay separate diffs.
 *
 * ═══ WHY onMount + createShapes RATHER THAN A STORE SNAPSHOT ═══
 *
 * tldraw will accept a pre-built store, which looks tidier. It is worse here:
 * a snapshot bypasses the shape and binding validators, so a serializer bug
 * would land in the store and surface later as a corrupt document. Going
 * through `createShapes` / `createBindings` means every record is validated by
 * the same `ShapeUtil` and `BindingUtil` the live canvas would use, and a
 * mismatch throws at load with a message naming the offending prop.
 *
 * Shapes before bindings, because a binding names shape ids and tldraw refuses
 * one whose endpoints do not exist.
 *
 * ═══ THE ID CASTS ARE CHECKED, NOT ASSERTED ═══
 *
 * The serializer types ids as `string` on purpose — it names no engine, which
 * is what lets it be tested without one. tldraw brands them (`TLShapeId` is
 * `shape:${string}`). This component is the boundary that knows both, so the
 * narrowing belongs here, and it is done with a runtime check rather than a
 * bare cast: an id that does not carry the expected prefix is a serializer bug
 * worth a loud error, not a silent `as`.
 */

import 'tldraw/tldraw.css';

import { useCallback } from 'react';
import {
    Tldraw,
    type Editor,
    type TLBindingId,
    type TLShapeId,
} from 'tldraw';

import { ProcessEdgeBindingUtil } from './tldraw/ProcessEdgeBindingUtil';
import { ProcessNodeShapeUtil } from './tldraw/ProcessNodeShapeUtil';
import {
    rowsToTldraw,
    type FreeformRecord,
    type GraphRows,
} from './tldraw/serializer';

/** Registered once at module scope — a new array each render remounts the editor. */
const SHAPE_UTILS = [ProcessNodeShapeUtil];
const BINDING_UTILS = [ProcessEdgeBindingUtil];

export interface TldrawProcessCanvasProps {
    /** The map's rows, exactly as the repository returns them. */
    rows: GraphRows;
    /**
     * `ProcessMap.freeformJson` — stickies, arrows, anything that is not a
     * process step. Opaque here: carried into the store and never inspected.
     */
    freeform?: FreeformRecord[];
    /**
     * Test and future-slice seam. The next slice needs the editor instance to
     * wire the write path; exposing it now keeps that diff from having to
     * restructure this one.
     */
    onEditorReady?: (editor: Editor) => void;
}

/** `shape:…` — the prefix `createShapeId` stamps, which the serializer already used. */
function asShapeId(id: string): TLShapeId {
    if (!id.startsWith('shape:')) {
        throw new Error(`Not a tldraw shape id: ${id}`);
    }
    return id as TLShapeId;
}

/** `binding:…` — see `bindingIdForEdgeKey`. */
function asBindingId(id: string): TLBindingId {
    if (!id.startsWith('binding:')) {
        throw new Error(`Not a tldraw binding id: ${id}`);
    }
    return id as TLBindingId;
}

export function TldrawProcessCanvas({
    rows,
    freeform = [],
    onEditorReady,
}: TldrawProcessCanvasProps) {
    const handleMount = useCallback(
        (editor: Editor) => {
            const graph = rowsToTldraw(rows, freeform);

            editor.createShapes(
                graph.shapes.map((s) => ({
                    id: asShapeId(s.id),
                    type: s.type,
                    x: s.x,
                    y: s.y,
                    props: s.props,
                })),
            );

            if (graph.bindings.length > 0) {
                editor.createBindings(
                    graph.bindings.map((b) => ({
                        id: asBindingId(b.id),
                        type: b.type,
                        fromId: asShapeId(b.fromId),
                        toId: asShapeId(b.toId),
                        props: b.props,
                    })),
                );
            }

            // Read-only LAST, after seeding: the flag refuses writes, and
            // `createShapes` is a write. Setting it first would load an empty
            // canvas and report no error, which is the quietest possible
            // version of this being wrong.
            editor.updateInstanceState({ isReadonly: true });

            onEditorReady?.(editor);
        },
        [rows, freeform, onEditorReady],
    );

    return (
        <div className="h-full w-full" data-tldraw-process-canvas="true">
            <Tldraw
                shapeUtils={SHAPE_UTILS}
                bindingUtils={BINDING_UTILS}
                onMount={handleMount}
            />
        </div>
    );
}
