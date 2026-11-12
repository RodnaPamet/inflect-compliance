'use client';

/**
 * THE AGENT-FLOW CANVAS (Phases 3 and 4 of `docs/ai-architecture/langflow.md`).
 *
 * tldraw, never xyflow (D-L2-3), inside the process-canvas module, so the
 * licensed editor ships only in the `/processes` segment and the module guard
 * needs no exception. The watermark stays where tldraw puts it.
 *
 * ═══ THE CANVAS OWNS GEOMETRY; THE INSPECTOR OWNS LOGIC ═══
 *
 * The flow (steps, tools, profiles, connections) arrives as props and is drawn;
 * the canvas never changes it. What a person can do here is MOVE a box, which is
 * reported through `onMove` as a layout change, and SELECT one, reported through
 * `onSelect`. There is no toolbar to draw with, a shape cannot be deleted from
 * the canvas (a before-delete handler refuses every deletion the sync did not
 * make), and a shape that is not one of ours is removed at the next sync. So no
 * gesture here produces a change to the flow, and the only write the editor
 * makes — a new profile version — is the inspector's.
 *
 * ═══ ORDER IS ADVISORY, AND DRAWN SO ═══
 *
 * Every connection is a dashed arrow: a reasoning engine reads a flow's order as
 * a specification and may deviate (the table in § The decision). Steps are
 * solid, because what they name — a tool, a propose step, a subagent — is
 * enforced by the funnel.
 */
import 'tldraw/tldraw.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createShapeId, type Editor, type TLComponents, type TLShapeId, Tldraw } from 'tldraw';

import { AGENT_FLOW_NODE_H, AGENT_FLOW_NODE_W, type FlowLayout } from '@/lib/processes/agent-flow/agent-flow-document';

import { AGENT_FLOW_NODE_SHAPE_TYPE, AgentFlowNodeShapeUtil, type AgentFlowNodeShape } from './AgentFlowNodeShapeUtil';

/** Module scope: a new array each render would remount the editor. */
const SHAPE_UTILS = [AgentFlowNodeShapeUtil];
const OPTIONS = { maxPages: 1 } as const;
/** No toolbar, no style panel: the inspector is where a flow is changed. */
const COMPONENTS: TLComponents = { Toolbar: null, StylePanel: null, PageMenu: null, ActionsMenu: null };

/** One step, its text already resolved. */
export interface AgentFlowCanvasNode {
    key: string;
    kind: string;
    label: string;
    detail: string;
    problems: string[];
    /** The approver's diff: 'added' | 'changed' | 'removed', or '' for none. */
    change: string;
}

export interface AgentFlowCanvasEdge {
    from: string;
    to: string;
    /** The approver's diff: 'added' | 'removed', or '' for none. */
    change: string;
}

export interface AgentFlowCanvasProps {
    nodes: readonly AgentFlowCanvasNode[];
    edges: readonly AgentFlowCanvasEdge[];
    layout: FlowLayout;
    /** A box was moved by the person: a LAYOUT change, never a flow change. */
    onMove?: (key: string, at: { x: number; y: number }) => void;
    onSelect?: (key: string | null) => void;
    /** The approver's view: nothing moves. */
    readOnly?: boolean;
    /** Test seam: the mounted editor. */
    onEditorReady?: (editor: Editor) => void;
}

export function stepShapeId(key: string): TLShapeId {
    return createShapeId(`step:${key}`);
}

function edgeShapeId(e: { from: string; to: string }): TLShapeId {
    return createShapeId(`edge:${e.from}->${e.to}`);
}

const EDGE_COLOR: Record<string, 'grey' | 'green' | 'red'> = { added: 'green', removed: 'red' };

export function AgentFlowCanvas({ nodes, edges, layout, onMove, onSelect, readOnly, onEditorReady }: AgentFlowCanvasProps) {
    const [editor, setEditor] = useState<Editor | null>(null);
    const syncing = useRef(false);
    const onMoveRef = useRef(onMove);
    const onSelectRef = useRef(onSelect);
    useEffect(() => {
        onMoveRef.current = onMove;
        onSelectRef.current = onSelect;
    }, [onMove, onSelect]);

    const handleMount = useCallback(
        (ed: Editor) => {
            // Only the sync deletes. A deletion from a gesture or a key would
            // remove a step from the drawing and not from the flow.
            ed.sideEffects.registerBeforeDeleteHandler('shape', () => (syncing.current ? undefined : false));
            setEditor(ed);
            onEditorReady?.(ed);
        },
        [onEditorReady],
    );

    // Draw the flow: create, update or remove shapes so the page shows exactly
    // these steps and connections at these positions.
    useEffect(() => {
        if (!editor) return;
        syncing.current = true;
        try {
            // Writable for the sync, read-only (or not) after it. tldraw drops
            // every create, update and delete while the instance is read-only,
            // so a sync run with the diff's read-only still set — the switch
            // back to editing, or any redraw of the diff — would change nothing
            // and leave the previous drawing on the page.
            editor.updateInstanceState({ isReadonly: false });
            editor.run(() => {
                const wantedSteps = new Set(nodes.map((n) => stepShapeId(n.key)));
                const wantedEdges = new Set(edges.map((e) => edgeShapeId(e)));
                const stale = editor
                    .getCurrentPageShapes()
                    .filter((s) => !wantedSteps.has(s.id) && !wantedEdges.has(s.id))
                    .map((s) => s.id);
                if (stale.length > 0) editor.deleteShapes(stale);

                for (const n of nodes) {
                    const id = stepShapeId(n.key);
                    const at = layout[n.key] ?? { x: 0, y: 0 };
                    const props = {
                        w: AGENT_FLOW_NODE_W,
                        h: AGENT_FLOW_NODE_H,
                        stepKey: n.key,
                        kind: n.kind,
                        label: n.label,
                        detail: n.detail,
                        problems: n.problems,
                        change: n.change,
                    };
                    const existing = editor.getShape<AgentFlowNodeShape>(id);
                    if (!existing) {
                        editor.createShape<AgentFlowNodeShape>({ id, type: AGENT_FLOW_NODE_SHAPE_TYPE, x: at.x, y: at.y, props });
                    } else if (
                        existing.x !== at.x ||
                        existing.y !== at.y ||
                        JSON.stringify(existing.props) !== JSON.stringify(props)
                    ) {
                        editor.updateShape<AgentFlowNodeShape>({ id, type: AGENT_FLOW_NODE_SHAPE_TYPE, x: at.x, y: at.y, props });
                    }
                }

                for (const e of edges) {
                    const from = layout[e.from];
                    const to = layout[e.to];
                    if (!from || !to) continue;
                    const sx = from.x + AGENT_FLOW_NODE_W;
                    const sy = from.y + AGENT_FLOW_NODE_H / 2;
                    const shape = {
                        id: edgeShapeId(e),
                        type: 'arrow' as const,
                        x: sx,
                        y: sy,
                        props: {
                            start: { x: 0, y: 0 },
                            end: { x: to.x - sx, y: to.y + AGENT_FLOW_NODE_H / 2 - sy },
                            dash: 'dashed' as const,
                            color: EDGE_COLOR[e.change] ?? ('grey' as const),
                            size: 's' as const,
                        },
                    };
                    if (editor.getShape(shape.id)) editor.updateShape(shape);
                    else editor.createShape(shape);
                }
            });
            editor.updateInstanceState({ isReadonly: readOnly === true });
        } finally {
            syncing.current = false;
        }
    }, [editor, nodes, edges, layout, readOnly]);

    // Fit once, when the first steps appear.
    const fitted = useRef(false);
    useEffect(() => {
        if (!editor || fitted.current || nodes.length === 0) return;
        fitted.current = true;
        editor.zoomToFit();
    }, [editor, nodes.length]);

    // A person's move of a box → a layout change. Nothing else is reported.
    useEffect(() => {
        if (!editor) return;
        return editor.store.listen(
            ({ changes }) => {
                if (syncing.current) return;
                for (const [before, after] of Object.values(changes.updated)) {
                    if (after.typeName !== 'shape' || after.type !== AGENT_FLOW_NODE_SHAPE_TYPE) continue;
                    if (before.typeName !== 'shape' || (before.x === after.x && before.y === after.y)) continue;
                    onMoveRef.current?.((after as AgentFlowNodeShape).props.stepKey, { x: after.x, y: after.y });
                }
            },
            { scope: 'document', source: 'user' },
        );
    }, [editor]);

    // Selection → the inspector.
    useEffect(() => {
        if (!editor) return;
        let last: string | null = null;
        return editor.store.listen(() => {
            const only = editor.getOnlySelectedShape();
            const key = only && only.type === AGENT_FLOW_NODE_SHAPE_TYPE ? (only as AgentFlowNodeShape).props.stepKey : null;
            if (key !== last) {
                last = key;
                onSelectRef.current?.(key);
            }
        });
    }, [editor]);

    return (
        <div className="h-full w-full" data-tldraw-agent-flow="true" data-process-canvas="true">
            <Tldraw shapeUtils={SHAPE_UTILS} onMount={handleMount} options={OPTIONS} components={COMPONENTS} />
        </div>
    );
}
