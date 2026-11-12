'use client';

/**
 * ONE AGENT ON THE CANVAS, read-only (Phase 2.2 of
 * `docs/ai-architecture/langflow.md`).
 *
 * tldraw, never xyflow (D-L2-3), and inside the process-canvas module, so the
 * licensed editor ships only in the `/processes` segment's chunk and the guard
 * `canvas-editor-stays-inside-its-module` needs no exception.
 *
 * ═══ NOTHING HERE CAN WRITE ═══
 *
 * The editor is put in read-only mode before anything is shown, the toolbar is
 * removed, and nothing listens for a change: there is no save path to reach,
 * and no layout is kept — positions are recomputed from the projection by the
 * process canvas's own layout engine on every open.
 *
 * Edges are tldraw's own arrows, unbound and placed from the layout. A spoke is
 * solid: it is a relation (this agent holds this tool), not an order. A
 * workflow's step order is solid where the engine walks it and DASHED where it
 * is advisory, which is the canvas's one visual statement about order.
 *
 * The tldraw watermark is left exactly where tldraw puts it (licence, 3.x).
 */
import 'tldraw/tldraw.css';

import { useCallback, useMemo } from 'react';
import { createShapeId, type Editor, type TLComponents, Tldraw } from 'tldraw';

import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import {
    AGENT_VIEW_NODE_H,
    AGENT_VIEW_NODE_W,
    buildAgentViewGraph,
    layoutAgentViewGraph,
} from '@/lib/processes/agent-view/agent-canvas-graph';

import { AGENT_VIEW_NODE_SHAPE_TYPE, AgentViewNodeShapeUtil } from './AgentViewNodeShapeUtil';
import { useAgentViewNodeText } from './agent-view-text';

/** Module scope: a new array each render would remount the editor. */
const SHAPE_UTILS = [AgentViewNodeShapeUtil];
const OPTIONS = { maxPages: 1 } as const;
/** No toolbar, no style panel: there is nothing to draw with on a view. */
const COMPONENTS: TLComponents = { Toolbar: null, StylePanel: null, PageMenu: null, ActionsMenu: null };

export interface AgentCanvasViewProps {
    projection: AgentCanvasProjection;
    /** Test seam: the mounted editor. */
    onEditorReady?: (editor: Editor) => void;
}

export function AgentCanvasView({ projection, onEditorReady }: AgentCanvasViewProps) {
    const textFor = useAgentViewNodeText();
    const graph = useMemo(() => buildAgentViewGraph(projection), [projection]);
    const positions = useMemo(() => layoutAgentViewGraph(graph), [graph]);

    const handleMount = useCallback(
        (editor: Editor) => {
            const at = (id: string) => positions[id] ?? { x: 0, y: 0 };
            editor.createShapes(
                graph.nodes.map((n) => {
                    const text = textFor(n);
                    return {
                        id: createShapeId(n.id),
                        type: AGENT_VIEW_NODE_SHAPE_TYPE,
                        x: at(n.id).x,
                        y: at(n.id).y,
                        props: { w: AGENT_VIEW_NODE_W, h: AGENT_VIEW_NODE_H, kind: n.kind, label: n.label, ...text },
                    };
                }),
            );
            editor.createShapes(
                graph.edges.map((e) => {
                    const from = at(e.source);
                    const to = at(e.target);
                    const sx = from.x + AGENT_VIEW_NODE_W;
                    const sy = from.y + AGENT_VIEW_NODE_H / 2;
                    return {
                        id: createShapeId(`edge:${e.id}`),
                        type: 'arrow' as const,
                        x: sx,
                        y: sy,
                        props: {
                            start: { x: 0, y: 0 },
                            end: { x: to.x - sx, y: to.y + AGENT_VIEW_NODE_H / 2 - sy },
                            dash: e.advisory ? ('dashed' as const) : ('solid' as const),
                            color: 'grey' as const,
                            size: 's' as const,
                        },
                    };
                }),
            );
            editor.updateInstanceState({ isReadonly: true });
            editor.zoomToFit();
            onEditorReady?.(editor);
        },
        [graph, positions, textFor, onEditorReady],
    );

    return (
        <div className="h-full w-full" data-tldraw-agent-view="true" data-process-canvas="true">
            <Tldraw shapeUtils={SHAPE_UTILS} onMount={handleMount} options={OPTIONS} components={COMPONENTS} />
        </div>
    );
}
