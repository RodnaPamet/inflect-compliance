'use client';

/**
 * A PROPOSED process map, drawn read-only on the process canvas (#5053).
 *
 * The review surfaces (`/agents/proposals` and the canvas checkpoint panel)
 * show a process-map proposal as a numbered list of steps and arrows. That
 * list is the record a reviewer approves. This is the picture beside it: the
 * same map on the same canvas renderer, so the reviewer sees the shape before
 * approving.
 *
 * ── THE POSITIONS ARE THE SERVER'S ──────────────────────────────────────
 *
 * Every step is drawn at the box the server's layout computed for it, and
 * approval creates the map at exactly those boxes. Nothing here lays anything
 * out. The rows are built with `buildTemplateGraph`, the builder approval uses,
 * so a step's type, label, subtitle and position, and an arrow's kind and
 * label, are the ones the approved map will have.
 *
 * ── WHY IT LIVES IN THIS DIRECTORY ──────────────────────────────────────
 *
 * The canvas editor may only be imported from inside the process module
 * (`tests/guards/canvas-editor-stays-inside-its-module.test.ts`). The agentic
 * review panel loads this file with `next/dynamic` and `ssr: false`, so the
 * editor stays out of every route's First Load JS and is fetched only when a
 * process-map proposal is on screen.
 *
 * ── A PICTURE, NOT A PLACE TO WORK ──────────────────────────────────────
 *
 * Read-only, embedded (no tldraw interface, a locked camera, never focused),
 * and its host makes the frame inert. It is fitted to the map once, when the
 * editor is ready and again on the next frame, once the container has its size.
 */
import { useCallback, useMemo } from 'react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import type { ProcessMapPreview } from '@/lib/agentic/process-map-proposal';
import { buildTemplateGraph } from '@/lib/processes/template-graph';

export interface ProposedProcessMapCanvasProps {
    preview: ProcessMapPreview;
}

/** Fit the whole map in view. `force`, because the embedded camera is locked. */
function fitToMap(editor: Editor): void {
    try {
        editor.zoomToFit({ force: true });
    } catch {
        // A container with no size yet (or no layout engine, as in jsdom) has
        // nothing to fit to; the next frame tries again.
    }
}

export function ProposedProcessMapCanvas({ preview }: ProposedProcessMapCanvasProps) {
    const rows = useMemo(
        () =>
            buildTemplateGraph({
                nodes: preview.steps.map((s) => ({
                    nodeKey: s.key,
                    nodeType: s.nodeType,
                    label: s.label,
                    ...(s.subtitle !== null ? { subtitle: s.subtitle } : {}),
                    posX: s.box.x,
                    posY: s.box.y,
                })),
                edges: preview.arrows.map((a) => ({
                    edgeKey: a.key,
                    sourceKey: a.fromKey,
                    targetKey: a.toKey,
                    ...(a.label !== null ? { labelOverride: a.label } : {}),
                })),
            }),
        [preview],
    );

    const onEditorReady = useCallback((editor: Editor) => {
        fitToMap(editor);
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(() => fitToMap(editor));
        }
    }, []);

    return (
        <div data-testid="proposed-process-map-canvas" className="h-full w-full">
            <TldrawProcessCanvas rows={rows} readOnly embedded onEditorReady={onEditorReady} />
        </div>
    );
}
