/**
 * @jest-environment jsdom
 *
 * The picture of a proposed process map is the real canvas, at the server's
 * boxes, and it is a picture (#5053).
 *
 * `ProposedProcessMapCanvas` mounts the process canvas with the rows built from
 * a proposal's preview. What this file holds, against a live tldraw store:
 *
 *   - every step is a process-node shape at exactly the box the server laid
 *     out, which is where approval creates it;
 *   - every arrow is a `flow` binding between the right two steps, in the
 *     right direction, carrying its label;
 *   - the store is read-only, the camera is locked, the editor did not take
 *     focus, and tldraw's own interface is not rendered.
 *
 * jsdom has no canvas, so nothing here is about what the picture looks like;
 * see `tests/helpers/tldraw-jsdom.ts`.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

// The editor is the canvas host's own; capture it on its way to the preview's
// fit-to-map callback, which still runs.
const mockEditors: Editor[] = [];
jest.mock('@/components/processes/TldrawProcessCanvas', () => {
    const actual = jest.requireActual('@/components/processes/TldrawProcessCanvas');
    const React = jest.requireActual('react');
    return {
        ...actual,
        TldrawProcessCanvas: (props: { onEditorReady?: (e: Editor) => void }) =>
            React.createElement(actual.TldrawProcessCanvas, {
                ...props,
                onEditorReady: (e: Editor) => {
                    mockEditors.push(e);
                    props.onEditorReady?.(e);
                },
            }),
    };
});

import { ProposedProcessMapCanvas } from '@/components/processes/ProposedProcessMapCanvas';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import {
    PROCESS_NODE_SHAPE_TYPE,
    nodeKeyFromShapeId,
} from '@/components/processes/tldraw/process-node-shape';
import {
    buildProcessMapPreview,
    canonicaliseProposedProcessMap,
    ProposedProcessMapSchema,
    type ProcessMapPreview,
} from '@/lib/agentic/process-map-proposal';

/** Through the real schema and preview builder; boxes stand in for the server layout. */
function previewOf(): ProcessMapPreview {
    const map = canonicaliseProposedProcessMap(
        ProposedProcessMapSchema.parse({
            name: 'Supplier onboarding',
            nodes: [
                { nodeKey: 'a', label: 'Receive the request', subtitle: 'Procurement' },
                { nodeKey: 'b', nodeType: 'decision', label: 'High risk?' },
                { nodeKey: 'c', label: 'Approve the supplier' },
            ],
            edges: [
                { sourceKey: 'a', targetKey: 'b' },
                { sourceKey: 'b', targetKey: 'c', labelOverride: 'No' },
            ],
        }),
    );
    return buildProcessMapPreview(map, {
        n1: { x: 32, y: 40, w: 220, h: 88 },
        n2: { x: 332, y: 40, w: 220, h: 88 },
        n3: { x: 632, y: 176, w: 220, h: 88 },
    });
}

async function mount(preview: ProcessMapPreview = previewOf()) {
    mockEditors.length = 0;
    let container!: HTMLElement;
    await act(async () => {
        ({ container } = render(
            <div style={{ width: 600, height: 256 }}>
                <ProposedProcessMapCanvas preview={preview} />
            </div>,
        ));
    });
    const editor = mockEditors[0];
    if (!editor) throw new Error('the canvas host never reported an editor');
    return { container, editor };
}

describe('the proposed map, drawn', () => {
    it('every step is a process-node shape at the box the server laid out', async () => {
        const preview = previewOf();
        const { editor } = await mount(preview);
        const shapes = editor.getCurrentPageShapes().filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE);
        expect(shapes).toHaveLength(preview.steps.length);
        for (const step of preview.steps) {
            const shape = shapes.find((s) => nodeKeyFromShapeId(String(s.id)) === step.key);
            expect(shape).toBeDefined();
            expect({ x: shape!.x, y: shape!.y }).toEqual({ x: step.box.x, y: step.box.y });
            const props = shape!.props as { label: string; nodeType: string; subtitle: string | null };
            expect(props.label).toBe(step.label);
            expect(props.nodeType).toBe(step.nodeType);
            expect(props.subtitle).toBe(step.subtitle);
        }
    });

    it('every arrow is a flow binding between the right two steps, with its label', async () => {
        const preview = previewOf();
        const { editor } = await mount(preview);
        const bindings = editor
            .getCurrentPageShapes()
            .flatMap((s) => editor.getBindingsFromShape(s.id, PROCESS_EDGE_BINDING_TYPE));
        expect(bindings).toHaveLength(preview.arrows.length);
        for (const arrow of preview.arrows) {
            const b = bindings.find((x) => (x.props as { edgeKey: string }).edgeKey === arrow.key);
            expect(b).toBeDefined();
            expect(nodeKeyFromShapeId(String(b!.fromId))).toBe(arrow.fromKey);
            expect(nodeKeyFromShapeId(String(b!.toId))).toBe(arrow.toKey);
            const props = b!.props as { edgeKind: string; labelOverride: string | null };
            expect(props.edgeKind).toBe('flow');
            expect(props.labelOverride).toBe(arrow.label);
        }
    });
});

describe('a picture, not a place to work', () => {
    it('the store is read-only and the camera is locked', async () => {
        const { editor } = await mount();
        expect(editor.getInstanceState().isReadonly).toBe(true);
        expect(editor.getCameraOptions().isLocked).toBe(true);
    });

    it('the editor does not take focus, so it never answers the page’s keyboard', async () => {
        const { editor } = await mount();
        expect(editor.getInstanceState().isFocused).toBe(false);
    });

    it('renders none of tldraw’s own interface', async () => {
        const { container } = await mount();
        expect(container.querySelector('.tlui-layout')).toBeNull();
        expect(container.querySelector('[data-embedded="true"]')).not.toBeNull();
    });
});
