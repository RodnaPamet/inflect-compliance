'use client';

/**
 * The tldraw process canvas — editable, reporting its own dirty state.
 *
 * ═══ WHAT THIS IS AND IS NOT ═══
 *
 * #2961's surface swap. This mounts a tldraw editor, seeds it from
 * `ProcessNode` / `ProcessEdge` rows through the serializer, and reports when
 * the user makes an edit worth saving.
 *
 * It still carries **no save path**: no `expectedVersion`, no
 * `surfaceVersionConflict`, no inspector or palette wiring. `onDirty` is the
 * seam — the page hands it `autosave.markDirty`, and `save()` is repointed at
 * `tldrawToRows` in its own diff, where the concurrency behaviour can be
 * reviewed on its own.
 *
 * NOTHING MOUNTS THIS YET. `isProcessCanvasTldrawEnabled` (#2996) has zero
 * consumers and still does after this file, so "which renderer" and "does the
 * renderer work" stay separate diffs.
 *
 * ═══ HISTORY IS THE EDITOR'S, NOT THE APP'S ═══
 *
 * `use-canvas-history` is deliberately NOT fed. It exists because xyflow has no
 * history of its own — it is a hand-rolled snapshot stack the change handler
 * pushes to. tldraw keeps its own, measured against a mounted editor:
 * `getCanUndo()` flips true after a `createShapes`, and `undo()` removes the
 * shape.
 *
 * Feeding both would double-handle undo — one entry from the editor and one
 * from the app for a single edit — which is the defect `handled-by-caller`
 * exists to prevent on the xyflow side. The document bar's
 * `canUndo` / `canRedo` / `handleUndo` / `handleRedo` map straight onto the
 * four editor methods when it is wired.
 *
 * ═══ SEEDING IS NOT AN EDIT ═══
 *
 * The store listener is registered AFTER the seed, and that ordering is
 * load-bearing. `createShapes` is a local change, so it arrives at a listener
 * as `source: 'user'` like any other — the filter does not exempt it. Register
 * first and every page load would mark the document dirty, autosave, and bump
 * `version` for a map nobody touched.
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

import { useCallback, useEffect, useRef } from 'react';
import {
    Tldraw,
    type Editor,
    type TLBindingId,
    type TLShapeId,
} from 'tldraw';

import { batchIsSubstantive } from '@/lib/processes/canvas-changes';
import { classifyTldrawStoreDiff } from '@/lib/processes/canvas-changes-tldraw';

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
     * Read-only view — the snapshot and diff surfaces show a past version
     * rather than the live document, and `CanvasDiffOverlay` has no business
     * being editable.
     *
     * Defaults to false: this is the canvas. The previous slice hard-coded
     * read-only because it had no write path to offer; now that it reports
     * edits, refusing them by default would be the wrong way round.
     */
    readOnly?: boolean;
    /**
     * Called once per store change that is an edit worth saving.
     *
     * The page wires `autosave.markDirty`. NOT called for transient churn —
     * selection, camera, a record tldraw rewrote with no visible difference —
     * nor for a change to a property the serializer does not persist, which
     * would otherwise produce a save that succeeds and discards.
     */
    onDirty?: () => void;
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
    readOnly = false,
    onDirty,
    onEditorReady,
}: TldrawProcessCanvasProps) {
    // Held in a ref so `handleMount` keeps a stable identity. `onMount` runs
    // once per editor, so a callback whose identity changed on every parent
    // render would either be ignored or force a remount — neither of which is
    // a thing to leave to chance in a component that seeds a store.
    const onDirtyRef = useRef(onDirty);
    useEffect(() => {
        onDirtyRef.current = onDirty;
    }, [onDirty]);
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
            if (readOnly) {
                editor.updateInstanceState({ isReadonly: true });
            }

            onEditorReady?.(editor);

            // AFTER the seed — see the header. A listener registered earlier
            // would see `createShapes` as a user change and mark a freshly
            // loaded map dirty.
            const unsubscribe = editor.store.listen(
                (entry) => {
                    if (batchIsSubstantive(classifyTldrawStoreDiff(entry.changes))) {
                        onDirtyRef.current?.();
                    }
                },
                {
                    // AN OPTIMISATION, NOT THE GUARD — measured, because the
                    // first version of this comment claimed otherwise.
                    //
                    // `document` skips camera, pointer and instance records so
                    // the mapper is not woken for every pan and mouse move. It
                    // is not what makes those harmless: every non-document
                    // record has a `typeName` the mapper does not recognise, so
                    // it classifies as `unknown` → transient regardless.
                    // Changing this to `'all'` reddens NO test, which is worth
                    // knowing before anyone treats it as a safety property.
                    //
                    // `user` likewise: the repo deliberately did not adopt
                    // tldraw sync (#2963), so there is no remote source today.
                    // It is here so that adding one later cannot make another
                    // editor's changes look like this user's unsaved work —
                    // which is a real guard, but for a case that does not yet
                    // exist and so cannot be tested.
                    scope: 'document',
                    source: 'user',
                },
            );
            // `onMount` may return a teardown, which is how the subscription
            // dies with the editor rather than outliving it.
            return unsubscribe;
        },
        [rows, freeform, readOnly, onEditorReady],
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
