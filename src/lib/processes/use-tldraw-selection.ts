'use client';

/**
 * The inspector's selection and write path, for a tldraw canvas.
 *
 * ── The inspector needs no porting ───────────────────────────────────
 *
 * `ProcessInspector` (714 lines) imports nothing from xyflow, and its selection
 * contract is already abstract: `SelectedCanvasNode` is `{ id, data }` and
 * `SelectedCanvasEdge` is `{ id, data, label? }`, both from `canvas-selection.ts`
 * — a module with zero engine references. So the panel is reused unchanged, and
 * this supplies its two props and applies its two patches.
 *
 * `toSelectedNode` / `toSelectedEdge` / `resolveSelection` are reused too. They
 * take structural records rather than xyflow types, and `resolveSelection` is
 * where "node wins when both are selected" is stated once — a rule the
 * inspector's own docblock is careful to say is "no longer a property of
 * whichever library happens to be underneath".
 *
 * ── The ids are KEYS, not shape ids ──────────────────────────────────
 *
 * `onUpdate(nodeId, …)` receives whatever `node.id` was, and on xyflow a node's
 * id IS its `nodeKey` — `serializeGraphForSave` writes `nodeKey: n.id`. So the
 * inspector's `nodeId` is a key on both engines, and this resolves it back to a
 * shape through `shapeIdForNodeKey`. Passing the tldraw shape id instead would
 * work until the first node created by drawing one, whose id is random and whose
 * key lives only in its props — the trap both shape modules document.
 *
 * ── Selection is OBSERVED ────────────────────────────────────────────
 *
 * `getSelectedShapes()` is a read. Called once it goes stale, and the inspector
 * would show whatever was selected when the component last rendered for some
 * other reason. So the store is listened to and the two slots mirrored.
 *
 * ── Why no markDirty here ────────────────────────────────────────────
 *
 * `TldrawProcessCanvas` already listens to the store and calls `onDirty` for a
 * substantive change, and `editor.updateShape` is one. An explicit
 * `markDirty()` beside each write would mark the document dirty twice for one
 * edit — harmless for a debounce, but it would make the dirty signal mean "an
 * edit, or an inspector edit counted again", which is the kind of double
 * handling the change-classification layer exists to avoid.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Editor, TLShapeId } from 'tldraw';

import {
    PROCESS_EDGE_BINDING_TYPE,
    type ProcessEdgeBinding,
} from '@/components/processes/tldraw/process-edge-binding';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeKeyFromShapeId,
    shapeIdForEdgeKey,
} from '@/components/processes/tldraw/process-edge-shape';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import {
    resolveSelection,
    toSelectedEdge,
    toSelectedNode,
    type CanvasSelection,
    type SelectedCanvasEdge,
    type SelectedCanvasNode,
} from '@/lib/processes/canvas-selection';

/** The inspector's node patch. Mirrors `ProcessInspectorProps['onUpdate']`. */
export interface NodePatch {
    label?: string;
    subtitle?: string | null;
    /** Accepted by the inspector, deliberately NOT applied — see `onUpdate`. */
    size?: unknown;
    linkedEntityId?: string | null;
}

/** The inspector's edge patch. Mirrors `onEdgeUpdate`. */
export interface EdgePatch {
    label?: string | null;
    variant?: string;
    controls?: unknown[];
}

interface SelectedShape {
    id: string;
    type?: string;
    props?: Record<string, unknown>;
}

export function useTldrawSelection(editor: Editor | null) {
    const [node, setNode] = useState<SelectedCanvasNode | null>(null);
    const [edge, setEdge] = useState<SelectedCanvasEdge | null>(null);

    useEffect(() => {
        if (!editor) {
            setNode(null);
            setEdge(null);
            return;
        }

        const sync = () => {
            const selected = editor.getSelectedShapes() as unknown as SelectedShape[];

            const nodeShape = selected.find((s) => s.type === PROCESS_NODE_SHAPE_TYPE);
            setNode(
                nodeShape
                    ? // `props.nodeKey`, not the shape id: the KEY is the
                      // contract the inspector and the row both speak.
                      toSelectedNode({
                          id: String(nodeShape.props?.nodeKey ?? ''),
                          data: nodeShape.props,
                      })
                    : null,
            );

            const lineShape = selected.find((s) => edgeKeyFromShapeId(s.id) !== null);
            if (!lineShape) {
                setEdge(null);
                return;
            }
            // The LINE is what the user clicks; the BINDING holds the data. The
            // line carries only geometry and a key, so resolving through to the
            // binding is what gives the inspector an edge worth inspecting.
            const edgeKey = edgeKeyFromShapeId(lineShape.id);
            const binding = findEdgeBinding(editor, edgeKey);
            setEdge(
                binding
                    ? toSelectedEdge({
                          id: binding.props.edgeKey,
                          data: binding.props,
                          label: binding.props.labelOverride,
                      })
                    : null,
            );
        };

        sync();
        return editor.store.listen(sync);
    }, [editor]);

    /**
     * Apply a node patch.
     *
     * `size` is deliberately NOT applied, and that is a decision rather than an
     * omission. It persists fine — it rides in `dataJson.size` — but the tldraw
     * node shape renders at `PROCESS_NODE_DEFAULT_W`/`_H` and never reads it, so
     * applying it would save a value that changes nothing the user can see.
     * Teaching the renderer to read it is the alternative the owner declined in
     * #2961, because #2960 made `dataJson` an opaque passthrough. Dropping it
     * here keeps the two decisions consistent; the control itself should be
     * hidden on this host, which is tracked on #2961 and is an inspector change.
     */
    const onUpdate = useCallback(
        (nodeId: string, patch: NodePatch) => {
            if (!editor) return;
            const shape = findNodeShape(editor, nodeId);
            if (!shape) return;
            const id = shape.id as TLShapeId;

            const props: Record<string, unknown> = {};
            if (patch.label !== undefined) props.label = patch.label;
            if (patch.subtitle !== undefined) props.subtitle = patch.subtitle;
            if (patch.linkedEntityId !== undefined) {
                // Merged into `dataJson` rather than replacing it: the column is
                // an opaque passthrough carrying whatever else the row holds,
                // and a whole-value write would drop every sibling key.
                const prev = (shape.props?.dataJson ?? null) as Record<string, unknown> | null;
                props.dataJson = { ...(prev ?? {}), linkedEntityId: patch.linkedEntityId };
            }
            if (Object.keys(props).length === 0) return;

            // One undo entry per inspector commit. tldraw owns history, so the
            // stopping point goes here rather than through the app's own stack.
            editor.markHistoryStoppingPoint();
            editor.updateShape({ id, type: PROCESS_NODE_SHAPE_TYPE, props } as never);
        },
        [editor],
    );

    /** Apply an edge patch to its BINDING, which is where an edge's data lives. */
    const onEdgeUpdate = useCallback(
        (edgeId: string, patch: EdgePatch) => {
            if (!editor) return;
            const binding = findEdgeBinding(editor, edgeId);
            if (!binding) return;

            const props: Record<string, unknown> = {};
            // `label: null` means CLEAR, and `labelOverride` is nullable, so the
            // null is written rather than treated as "no change" — an undefined
            // check is what distinguishes them.
            if (patch.label !== undefined) props.labelOverride = patch.label;
            // `variant` is the inspector's name for what the row calls
            // `edgeKind` — `edgeKindOf` performs exactly this rename on the
            // xyflow side, reading `data.variant` into the row's `edgeKind`.
            if (patch.variant !== undefined) props.edgeKind = patch.variant;
            if (patch.controls !== undefined) props.controls = patch.controls;
            if (Object.keys(props).length === 0) return;

            editor.markHistoryStoppingPoint();
            editor.updateBinding({
                id: binding.id,
                type: PROCESS_EDGE_BINDING_TYPE,
                props,
            } as never);

            // The DRAWN line carries its own copy of `edgeKind`, because the
            // binding is not cheaply findable from the line (it joins the two
            // node shapes; the line is a third record neither end references).
            // This is the one write that is not a reload, so it is the one
            // place that has to keep the two in step — without it the variant
            // saves, survives a reload, and changes nothing on screen until
            // then, which is the shape of the bug #3090 was filed for.
            if (patch.variant !== undefined) {
                editor.updateShape({
                    id: shapeIdForEdgeKey(binding.props.edgeKey),
                    type: PROCESS_EDGE_SHAPE_TYPE,
                    props: { edgeKind: patch.variant },
                } as never);
            }
        },
        [editor],
    );

    const selection: CanvasSelection = resolveSelection(node, edge);

    return { node, edge, selection, onUpdate, onEdgeUpdate };
}

/**
 * The node shape carrying this `nodeKey`.
 *
 * Searched by PROP, not by `shapeIdForNodeKey(nodeKey)`.
 *
 * The derived id is correct only for a node that came from a row. A node the
 * user DREW has a random id and its key lives only in its props — the trap both
 * shape modules document, and the one this file's own header describes before
 * the first version of this function went and reproduced it. Resolving by the
 * derived id meant an inspector edit on a drawn node silently did nothing: the
 * lookup missed, the function returned early, and no error surfaced anywhere.
 *
 * `shapeIdForNodeKey` is still the right way to CREATE a shape for a known row;
 * it is the wrong way to FIND one that may not have come from a row.
 */
function findNodeShape(editor: Editor, nodeKey: string): SelectedShape | null {
    const match = editor
        .getCurrentPageShapes()
        .find(
            (s) =>
                (s as unknown as SelectedShape).type === PROCESS_NODE_SHAPE_TYPE &&
                (s as unknown as SelectedShape).props?.nodeKey === nodeKey,
        );
    return (match as unknown as SelectedShape) ?? null;
}

/** The process-edge binding carrying this key, if the store holds one. */
function findEdgeBinding(editor: Editor, edgeKey: string | null): ProcessEdgeBinding | null {
    if (!edgeKey) return null;
    const match = editor.store
        .allRecords()
        .find(
            (r) =>
                r.typeName === 'binding' &&
                (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE &&
                (r as unknown as ProcessEdgeBinding).props.edgeKey === edgeKey,
        );
    return (match as unknown as ProcessEdgeBinding) ?? null;
}
