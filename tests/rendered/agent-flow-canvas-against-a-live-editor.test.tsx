/**
 * The agent-flow canvas on a REAL tldraw editor (Phase 3,
 * docs/ai-architecture/langflow.md).
 *
 * The canvas owns geometry and nothing else, so what is read is the store and
 * the two callbacks: one shape per step and one dashed arrow per connection, a
 * move reported as a layout change and as nothing more, a step that cannot be
 * deleted from the canvas, and a read-only diff view.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { AgentFlowCanvas, stepShapeId, type AgentFlowCanvasProps } from '@/components/processes/agent-flow/AgentFlowCanvas';
import { AGENT_FLOW_NODE_SHAPE_TYPE } from '@/components/processes/agent-flow/AgentFlowNodeShapeUtil';

const BASE: Omit<AgentFlowCanvasProps, 'onEditorReady'> = {
    nodes: [
        { key: 'read-1', kind: 'read', label: 'Read posture', detail: 'get_compliance_posture', problems: [], change: '' },
        { key: 'synthesis-1', kind: 'synthesis', label: 'Answer', detail: 'Writes the answer', problems: [], change: '' },
    ],
    edges: [{ from: 'read-1', to: 'synthesis-1', change: '' }],
    layout: { 'read-1': { x: 0, y: 0 }, 'synthesis-1': { x: 400, y: 0 } },
};

async function mount(over: Partial<AgentFlowCanvasProps> = {}): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <AgentFlowCanvas {...BASE} {...over} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not finish mounting');
    return editor;
}

type Shape = { id: string; type: string; x: number; y: number; props: Record<string, unknown> };
const shapes = (editor: Editor) =>
    editor.store.allRecords().filter((r) => r.typeName === 'shape') as unknown as Shape[];

describe('the agent-flow canvas on a live editor', () => {
    it('draws one shape per step and one dashed arrow per connection, since order is advisory', async () => {
        const editor = await mount();
        expect(shapes(editor).filter((s) => s.type === AGENT_FLOW_NODE_SHAPE_TYPE)).toHaveLength(2);
        const arrows = shapes(editor).filter((s) => s.type === 'arrow');
        expect(arrows).toHaveLength(1);
        expect(arrows[0].props.dash).toBe('dashed');
    });

    it('a person moving a step is reported as a layout change, and nothing else is reported', async () => {
        const onMove = jest.fn();
        const onSelect = jest.fn();
        const editor = await mount({ onMove, onSelect });
        act(() => {
            editor.updateShape({ id: stepShapeId('read-1'), type: AGENT_FLOW_NODE_SHAPE_TYPE, x: 120, y: 60 });
        });
        expect(onMove).toHaveBeenCalledWith('read-1', { x: 120, y: 60 });
        // The step's logic on the canvas is untouched by the move.
        const moved = editor.getShape(stepShapeId('read-1')) as unknown as Shape;
        expect(moved.props.label).toBe('Read posture');
        expect(moved.props.stepKey).toBe('read-1');
    });

    it('a step cannot be deleted from the canvas: the flow, not the drawing, says what exists', async () => {
        const editor = await mount();
        act(() => {
            editor.deleteShapes([stepShapeId('read-1')]);
        });
        expect(editor.getShape(stepShapeId('read-1'))).toBeDefined();
    });

    it('selecting a step names it to the inspector', async () => {
        const onSelect = jest.fn();
        const editor = await mount({ onSelect });
        act(() => {
            editor.select(stepShapeId('synthesis-1'));
        });
        expect(onSelect).toHaveBeenLastCalledWith('synthesis-1');
    });

    it('the approver’s diff is read-only and marks each change on its step', async () => {
        const editor = await mount({
            readOnly: true,
            nodes: [
                { ...BASE.nodes[0], change: 'changed' },
                { ...BASE.nodes[1], change: 'added' },
            ],
            edges: [{ from: 'read-1', to: 'synthesis-1', change: 'added' }],
        });
        expect(editor.getInstanceState().isReadonly).toBe(true);
        expect((editor.getShape(stepShapeId('synthesis-1')) as unknown as Shape).props.change).toBe('added');
        const arrow = shapes(editor).find((s) => s.type === 'arrow');
        expect(arrow?.props.color).toBe('green');
    });
});
