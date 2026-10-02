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
 * THIS IS NOW THE ONLY PROCESS CANVAS. The paragraph here used to read
 * "NOTHING MOUNTS THIS YET" — true when the file was written, and the exact
 * opposite of true since #3079 deleted the xyflow renderer and the flag that
 * chose between them. Left uncorrected it would tell the next reader that the
 * component they are looking at is unreachable.
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

import { useTranslations } from 'next-intl';

import { useMediaQuery } from '@/components/ui/hooks/use-media-query';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { atom, type Atom, type Editor, type TLBindingId, Tldraw, type TLShape, type TLShapeId } from 'tldraw';

import { batchIsSubstantive } from '@/lib/processes/canvas-changes';
import { classifyTldrawStoreDiff } from '@/lib/processes/canvas-changes-tldraw';

import { PALETTE_DRAG_MIME, type PaletteDropPayload } from './ProcessPalette';
import { installArrowToEdgeConversion } from './tldraw/arrow-to-edge';
import {
    edgeEndpointIndex,
    shapeVisibilityForScope,
    visibleNodeKeys,
} from './tldraw/drill-scope-host';
import type { EdgeRefusal } from './tldraw/edge-validation';
import { ProcessEdgeBindingUtil } from './tldraw/ProcessEdgeBindingUtil';
import { ProcessEdgeShapeUtil } from './tldraw/ProcessEdgeShapeUtil';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeLineGeometry,
    shapeIdForEdgeKey,
    automationChipKey,
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
     * An arrow was drawn between two process nodes but the edge is not allowed.
     *
     * A CALLBACK rather than a toast raised here: this component's docblock is
     * explicit that it carries no chrome, and the codebase passes `toast` in
     * (`useTldrawDocumentBar` takes it as a parameter) rather than letting a
     * low-level canvas reach for it. The host decides how a refusal is shown.
     *
     * Unset means refusals are SILENT, which is a real gap rather than a
     * neutral default — the user drew something and it vanished.
     */
    onEdgeRefused?: (refusals: EdgeRefusal[]) => void;
    /**
     * The group the user has drilled into, or null at root.
     *
     * A GROUP ID rather than a pre-computed set of visible keys. The scope is
     * derived from the store — which nodes name this group as their parent — so
     * a set computed by the caller goes stale the moment a node is added to the
     * group, moved into it, or deleted. Passing the question instead of the
     * answer means it is re-answered against the live store.
     */
    drillGroupId?: string | null;
    /**
     * The user double-clicked a GROUP node and wants to go inside it.
     *
     * Fired only for `nodeType === 'group'`: double-clicking a step is how
     * tldraw starts label editing, and stealing that would break renaming.
     */
    onEnterGroup?: (nodeKey: string) => void;
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
    onEdgeRefused,
    drillGroupId = null,
    onEnterGroup,
    onEditorReady,
}: TldrawProcessCanvasProps) {
    // Held in a ref so `handleMount` keeps a stable identity. `onMount` runs
    // once per editor, so a callback whose identity changed on every parent
    // render would either be ignored or force a remount — neither of which is
    // a thing to leave to chance in a component that seeds a store.
    const onDirtyRef = useRef(onDirty);
    const onEdgeRefusedRef = useRef(onEdgeRefused);
    const onEnterGroupRef = useRef(onEnterGroup);
    /**
     * Mount signal, because `editorRef` alone cannot drive an effect.
     *
     * The editor arrives in `onMount`, not at render, so an effect reading
     * `editorRef.current` on its first pass finds null and — with no dependency
     * that ever changes — never runs again. The listeners below would simply
     * never be installed, with nothing failing to say so.
     *
     * A boolean rather than holding the editor in state: the editor is a large
     * mutable object and putting it in state invites a re-render on identity
     * change. The ref stays the accessor; this only says "it is there now".
     */
    /**
     * `undefined` rather than `"false"` when not mobile, matching what the
     * xyflow canvas emitted. The CSS selector is an attribute PRESENCE match
     * on `[data-mobile-layout="true"]`, so a literal "false" would be inert
     * either way — but the two hosts emitting different shapes for the same
     * state is how a future selector change breaks only one of them.
     */
    const { isMobile } = useMediaQuery();
    /**
     * For the automation edge-kind chip (VR-5).
     *
     * The chip's text is resolved HERE and stored on the line, because no shape
     * util in this codebase takes a translator — see `chipLabel`'s own note in
     * `process-edge-shape.ts`. `automation.edges` is the namespace the xyflow
     * renderer used, and the five keys survived the cutover untouched.
     */
    const tEdges = useTranslations('automation.edges');

    /**
     * The chip text for an edge, or `''` for no chip.
     *
     * Three ways to get nothing, and each is a real case rather than a guard
     * for its own sake:
     *   • the kind has no chip — every document variant, plus `trigger-flow`,
     *     which is the default automation flow and would put a pill on every
     *     ordinary edge;
     *   • the edge has an explicit label, which the user typed and which wins;
     *   • the edge carries controls, whose pills already occupy that space.
     */
    const chipTextFor = useCallback(
        (edgeKind: string, labelOverride: unknown, controls: unknown): string => {
            if (typeof labelOverride === 'string' && labelOverride.length > 0) return '';
            if (Array.isArray(controls) && controls.length > 0) return '';
            const key = automationChipKey(edgeKind);
            return key ? tEdges(key) : '';
        },
        [tEdges],
    );
    const [editorReady, setEditorReady] = useState(false);

    /**
     * The drill scope lives in an ATOM, and that is not a style choice.
     *
     * `getShapeVisibility` is consulted through `Editor.getIsShapeHiddenCache`,
     * which is decorated `@computed` from tldraw's own signals library. A
     * `computed` invalidates only when a SIGNAL it read during evaluation
     * changes. A plain React ref is not a signal, so a predicate reading one
     * would return the new answer and the cache would never re-ask: the scope
     * correct in code and stale on screen.
     *
     * That failure is invisible to a test which calls the predicate directly —
     * which is exactly what I had planned to write. The first draft of this
     * also called `editor.markShapesDirty?.()` to force a repaint; that method
     * does not exist, and the optional call made its absence silent.
     *
     * `atom` comes from `tldraw` itself. Neither `@tldraw/state` nor a new
     * dependency is needed — the barrel re-exports `atom`, `computed`,
     * `useValue`, `react`, `transact` and `track`, which four separate greps of
     * the `.d.ts` denied before a one-line require settled it.
     */
    const scopeAtom = useMemo<Atom<Set<string> | null>>(
        () => atom('processDrillScope', null),
        [],
    );
    const endpointsAtom = useMemo<Atom<Map<string, { source: string; target: string }>>>(
        () => atom('processEdgeEndpoints', new Map()),
        [],
    );
    const disposeArrowConversion = useRef<(() => void) | null>(null);
    useEffect(() => {
        onDirtyRef.current = onDirty;
    }, [onDirty]);
    useEffect(() => {
        onEdgeRefusedRef.current = onEdgeRefused;
    }, [onEdgeRefused]);
    useEffect(() => {
        onEnterGroupRef.current = onEnterGroup;
    }, [onEnterGroup]);
    /*
        `chipTextFor` through a ref for the reason stated on `onDirtyRef`:
        `handleMount` runs once per editor and installs the arrow converter for
        that editor's whole life, so a closure would pin whichever translator
        existed at mount. Reading it from a ref also takes it out of
        `handleMount`'s dependency list, where adding it would re-seed the
        entire canvas on a locale change — a remount to re-render two chips.
    */
    const chipTextForRef = useRef(chipTextFor);
    useEffect(() => {
        chipTextForRef.current = chipTextFor;
    }, [chipTextFor]);
    // Unregister the side-effect handlers with the component. Without this a
    // remount — which a 409 conflict performs deliberately — would leave the
    // previous editor's handlers registered against a store nobody reads.
    useEffect(() => () => {
        disposeArrowConversion.current?.();
        disposeArrowConversion.current = null;
    }, []);
    const editorRef = useRef<Editor | null>(null);
    /**
     * `getShapeVisibility`, handed to `<Tldraw>` once.
     *
     * STABLE by construction — it closes over the two atoms and nothing else,
     * so its identity never changes. A new function each render would be a new
     * editor option on every pass.
     *
     * Reading `.get()` here is what subscribes the hidden-cache `computed` to
     * the atoms, so setting either one below invalidates it and the canvas
     * repaints. That subscription is the entire mechanism; see the atom
     * docblock above for what happens without it.
     */
    const getShapeVisibility = useCallback(
        (shape: TLShape) =>
            shapeVisibilityForScope(scopeAtom.get(), endpointsAtom.get())(
                // `TLShape` is a union whose `props` differ per type; the
                // predicate reads only `id`, `type` and `props.nodeKey`, so it
                // takes the structural minimum rather than discriminating a
                // union it does not care about.
                shape as unknown as { id: string; type?: string; props?: { nodeKey?: unknown } },
            ),
        [scopeAtom, endpointsAtom],
    );

    /**
     * Recompute the scope when the drill LEVEL changes or the GRAPH does.
     *
     * Both triggers matter and neither subsumes the other: entering a group
     * changes the question, and adding a node to the group you are already
     * inside changes the answer.
     */
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const recompute = () => {
            scopeAtom.set(visibleNodeKeys(editor, drillGroupId));
            endpointsAtom.set(edgeEndpointIndex(editor));
        };
        recompute();
        return editor.store.listen(recompute);
    }, [drillGroupId, scopeAtom, endpointsAtom, editorReady]);

    /**
     * Double-click a GROUP node to go inside it.
     *
     * The event carries a POINT and no shape — `TLClickEventInfo` has
     * `{ button, name, phase, point, pointerId, type }` — so the shape has to
     * be hit-tested. Taking `inputs.currentPagePoint` rather than converting
     * `info.point` myself: the editor already maintains the page-space
     * position, and a second conversion is a second chance to get the camera
     * transform wrong.
     *
     * Gated to `phase === 'up'` so one gesture fires once, and to groups so
     * double-clicking a step still starts tldraw's label editing.
     */
    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;
        const onEvent = (info: { type?: string; name?: string; phase?: string }) => {
            if (info.type !== 'click' || info.name !== 'double_click') return;
            if (info.phase !== 'up') return;
            const hit = editor.getShapeAtPoint(editor.inputs.currentPagePoint, {
                hitInside: true,
            }) as { type?: string; props?: { nodeKey?: unknown; nodeType?: unknown } } | undefined;
            if (!hit || hit.type !== PROCESS_NODE_SHAPE_TYPE) return;
            if (hit.props?.nodeType !== 'group') return;
            const key = hit.props?.nodeKey;
            if (typeof key === 'string' && key.length > 0) onEnterGroupRef.current?.(key);
        };
        editor.on('event', onEvent);
        return () => {
            editor.off('event', onEvent);
        };
    }, [editorReady]);

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
                            props: {
                                edgeKey: b.props.edgeKey,
                                edgeKind: b.props.edgeKind,
                                // `?? ''` because the binding's label is
                                // NULLABLE and the shape prop is not — see the
                                // prop's own note on why the line does not
                                // carry the null.
                                label: b.props.labelOverride ?? '',
                                // PRECEDENCE, resolved here because the binding
                                // is what carries both competing values: an
                                // explicit label wins over the chip, and a
                                // controls-bearing edge shows neither (the
                                // control pills are the label). Same order the
                                // xyflow renderer enforced with
                                // `!hasControls && !label && autoLabel`.
                                chipLabel: chipTextForRef.current(
                                    b.props.edgeKind,
                                    b.props.labelOverride,
                                    b.props.controls,
                                ),
                                dx: g.dx,
                                dy: g.dy,
                            },
                        },
                    ];
                });
                if (lines.length > 0) editor.createShapes(lines);
            }

            /**
             * An arrow drawn between two process nodes IS an edge.
             *
             * Installed after seeding so the load's own binding creation does
             * not enter the candidate set, and skipped entirely when read-only
             * — a reader cannot draw, and registering a handler that can write
             * on a surface that refuses writes is the kind of inconsistency
             * that gets discovered by a stack trace.
             *
             * This is also the canvas's ONLY way to create an edge. Before it,
             * `createBindings` was reachable only from the seed above, so a user
             * could not draw a connection at all — while the default toolbar's
             * arrow tool let them draw something that looked exactly like one
             * and persisted as annotation.
             */
            if (!readOnly) {
                disposeArrowConversion.current?.();
                disposeArrowConversion.current = installArrowToEdgeConversion(editor, {
                    onRefuse: (refusals) => onEdgeRefusedRef.current?.(refusals),
                    // Through the REF, like every other callback here. `onMount`
                    // runs once and its closure would pin the first `onDirty`,
                    // so a later prop change would mark the wrong host dirty —
                    // which is why `onDirtyRef` exists at all.
                    onConverted: () => onDirtyRef.current?.(),
                    /*
                        VR-5's chip on a freshly DRAWN edge. `null, []` are the
                        label and controls a one-millisecond-old edge has by
                        construction — the converter writes both empty — so this
                        is the same precedence function with its two losing
                        arguments pinned, rather than a second rule that could
                        drift from the load path's.
                    */
                    resolveChipLabel: (kind) => chipTextForRef.current(kind, null, []),
                });
            }

            // Read-only LAST, after seeding: the flag refuses writes, and
            // `createShapes` is a write. Setting it first would load an empty
            // canvas and report no error, which is the quietest possible
            // version of this being wrong.
            if (readOnly) {
                editor.updateInstanceState({ isReadonly: true });
            }

            setEditorReady(true);
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
            /*
                TWO canvas attributes, and both are load-bearing.

                `data-tldraw-process-canvas` is this host's own marker and is
                what `tldraw-palette-drop-creates-a-node` resolves the drop
                target by.

                `data-process-canvas` is the RENDERER-AGNOSTIC one, and it is
                here because `globals.css` carries a `max-width: 767px` rule
                keyed on `[data-process-canvas][data-mobile-layout]` that turns
                the node palette from a vertical sidebar into a horizontal
                strip. The xyflow canvas emitted it; this one did not, so after
                the cutover that rule would have matched nothing and the
                palette would have kept a sidebar's width on a phone.

                Emitting the generic name rather than widening the selector:
                the selector is about THE PROCESS CANVAS, not about a renderer,
                and a second renderer-specific arm in CSS is a thing nobody
                would think to update next time.
            */
            data-tldraw-process-canvas="true"
            data-process-canvas="true"
            data-mobile-layout={isMobile ? 'true' : undefined}
            onDragOver={onDragOver}
            onDrop={onDrop}
        >
            <Tldraw
                shapeUtils={SHAPE_UTILS}
                bindingUtils={BINDING_UTILS}
                getShapeVisibility={getShapeVisibility}
                onMount={handleMount}
            />
        </div>
    );
}
