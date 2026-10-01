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

import { useCallback, useEffect, useRef, type DragEvent } from 'react';
import {
    Tldraw,
    type Editor,
    type TLBindingId,
    type TLShapeId,
} from 'tldraw';

import { batchIsSubstantive } from '@/lib/processes/canvas-changes';
import { classifyTldrawStoreDiff } from '@/lib/processes/canvas-changes-tldraw';

import { PALETTE_DRAG_MIME, type PaletteDropPayload } from './ProcessPalette';
import { ProcessEdgeBindingUtil } from './tldraw/ProcessEdgeBindingUtil';
import { ProcessEdgeShapeUtil } from './tldraw/ProcessEdgeShapeUtil';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeLineGeometry,
    shapeIdForEdgeKey,
} from './tldraw/process-edge-shape';
import {
    PROCESS_NODE_DEFAULT_H,
    PROCESS_NODE_DEFAULT_W,
    PROCESS_NODE_FALLBACK_KIND,
    PROCESS_NODE_SHAPE_TYPE,
    shapeIdForNodeKey,
} from './tldraw/process-node-shape';
// Engine-free (zero xyflow references), unlike `ProcessTypedNode` where the
// step constant lives.
import { isProcessNodeKind } from './node-taxonomy';
import { ProcessNodeShapeUtil } from './tldraw/ProcessNodeShapeUtil';
import {
    rowsToTldraw,
    type FreeformRecord,
    type GraphRows,
} from './tldraw/serializer';

/** Registered once at module scope — a new array each render remounts the editor. */
// Both shape utils. The edge LINE is a shape because a `BindingUtil` cannot
// render — registering only the node is what left the canvas drawing steps with
// no connectors between them.
const SHAPE_UTILS = [ProcessNodeShapeUtil, ProcessEdgeShapeUtil];
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

/**
 * A fresh `nodeKey` for a node created by dropping one.
 *
 * The xyflow handler uses `node-${Date.now()}`, and two drops inside one
 * millisecond would then share a key. That is unlikely by hand and certain
 * under a test that drops twice — and a duplicate `nodeKey` is not cosmetic:
 * the row is keyed on it, so the save would collapse two nodes into one.
 *
 * The random suffix is not for unguessability, only for distinctness.
 */
export function mintNodeKey(): string {
    return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    const editorRef = useRef<Editor | null>(null);
    const handleMount = useCallback(
        (editor: Editor) => {
            // Kept so the drop handler can reach the editor; `onMount` is the
            // only place tldraw hands it over.
            editorRef.current = editor;
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

                /**
                 * The drawn lines, derived from the bindings just created.
                 *
                 * AFTER the bindings and after the node shapes, because the
                 * geometry comes from `getShapePageBounds` on both endpoints —
                 * neither of which exists until its shape does.
                 *
                 * Derived rather than loaded: `ProcessEdge` stays the single
                 * source of truth, and `partitionCanvas` sorts this type into
                 * its `derived` bucket so a line can never be written to
                 * `freeformJson` and then restored on top of a fresh one.
                 */
                const lines = graph.bindings.flatMap((b) => {
                    const from = editor.getShapePageBounds(asShapeId(b.fromId));
                    const to = editor.getShapePageBounds(asShapeId(b.toId));
                    // An endpoint with no bounds means a binding whose shape is
                    // not on this page. Skipped rather than drawn at the origin,
                    // which would put a stray line through the map.
                    if (!from || !to) return [];
                    const g = edgeLineGeometry(from, to);
                    return [
                        {
                            id: shapeIdForEdgeKey(b.props.edgeKey),
                            type: PROCESS_EDGE_SHAPE_TYPE,
                            x: g.x,
                            y: g.y,
                            props: { edgeKey: b.props.edgeKey, dx: g.dx, dy: g.dy },
                        },
                    ];
                });
                if (lines.length > 0) editor.createShapes(lines);
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

    /**
     * Allow the drop. Without `preventDefault` here the browser refuses the
     * drag entirely and `onDrop` never fires — the palette would look draggable
     * and do nothing, which is indistinguishable from a broken handler.
     */
    const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    }, []);

    /**
     * Create a node where the user dropped it.
     *
     * Drag-from-palette is the ONLY creation path, so without this the canvas
     * can open, move, rename, delete, export and inspect a map and never add to
     * one.
     *
     * The parse is deliberately forgiving, mirroring the xyflow handler: the
     * payload crosses a `dataTransfer` boundary, so anything could arrive, and
     * a drop that produced a default-labelled step beats one that throws.
     */
    const onDrop = useCallback(
        (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const editor = editorRef.current;
            // BELT-AND-BRACES, and measured as such: removing this guard still
            // creates nothing, because `updateInstanceState({ isReadonly })`
            // makes tldraw itself refuse `createShapes`. That is the control.
            // This stays because it says the intent at the call site and does
            // not depend on a tldraw behaviour nothing here asserts — but it is
            // not what delivers the property, and the test asserts the OUTCOME
            // rather than this line.
            if (!editor || readOnly) return;

            const raw = event.dataTransfer.getData(PALETTE_DRAG_MIME);
            if (!raw) return;

            let kind: string = PROCESS_NODE_FALLBACK_KIND;
            let label = raw;
            try {
                const parsed = JSON.parse(raw) as PaletteDropPayload;
                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    isProcessNodeKind(parsed.kind) &&
                    typeof parsed.label === 'string'
                ) {
                    kind = parsed.kind;
                    label = parsed.label;
                }
            } catch {
                // Non-JSON payload — keep the raw-label fallback.
            }

            const point = editor.screenToPage({ x: event.clientX, y: event.clientY });
            const nodeKey = mintNodeKey();

            // NO explicit history mark. The xyflow handler had to be fixed to
            // call `history.push`, because dropping a node and pressing undo
            // did nothing — so the obvious move here was to mirror it. Measured
            // instead: removing `markHistoryStoppingPoint()` leaves the drop
            // undoable, because tldraw records store operations itself. Keeping
            // it would have been a line whose comment claimed it was load-
            // bearing when a mutation proved it was not.
            editor.createShapes([
                {
                    id: asShapeId(shapeIdForNodeKey(nodeKey)),
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: point.x,
                    y: point.y,
                    props: {
                        w: PROCESS_NODE_DEFAULT_W,
                        h: PROCESS_NODE_DEFAULT_H,
                        nodeKey,
                        nodeType: kind,
                        label,
                        subtitle: null,
                        parentNodeKey: null,
                        dataJson: null,
                    },
                },
            ]);
        },
        [readOnly],
    );

    return (
        <div
            className="h-full w-full"
            data-tldraw-process-canvas="true"
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <Tldraw
                shapeUtils={SHAPE_UTILS}
                bindingUtils={BINDING_UTILS}
                onMount={handleMount}
            />
        </div>
    );
}
