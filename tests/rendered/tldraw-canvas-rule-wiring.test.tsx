/**
 * @jest-environment jsdom
 *
 * On a live tldraw editor: the inspector sees a step's kind and the rules it
 * configures, a save's new rule ids reach the open canvas without making it
 * dirty, and "Open on canvas" selects the step it names.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render, renderHook } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { applySavedRuleIds } from '@/components/processes/tldraw/apply-saved-rule-ids';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import { useTldrawSelection } from '@/lib/processes/use-tldraw-selection';

const node = (nodeKey: string, nodeType: string, posX: number, dataJson: Record<string, unknown> | null = null) => ({
    nodeKey,
    nodeType,
    label: nodeKey,
    subtitle: null,
    posX,
    posY: 0,
    parentNodeKey: null,
    dataJson,
});

/** Trigger → Condition → Action (owns r1), and a second Action with no rule. */
const FLOW: GraphRows = {
    nodes: [
        node('t', 'trigger', 0),
        node('c', 'condition', 300),
        node('a', 'action', 600, { ruleId: 'r1' }),
        node('b', 'action', 900),
    ],
    edges: [
        { edgeKey: 'e1', sourceKey: 't', targetKey: 'c', edgeKind: 'flow', labelOverride: null, controls: [], dataJson: null },
        { edgeKey: 'e2', sourceKey: 'c', targetKey: 'a', edgeKind: 'flow', labelOverride: null, controls: [], dataJson: null },
    ],
};

async function mount(props: { onDirty?: () => void; focusNodeKey?: string } = {}): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <TldrawProcessCanvas
                    rows={FLOW}
                    onEditorReady={(e) => (editor = e)}
                    {...(props.onDirty ? { onDirty: props.onDirty } : {})}
                    {...(props.focusNodeKey ? { focusNodeKey: props.focusNodeKey } : {})}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount');
    return editor;
}

const shapeOf = (editor: Editor, nodeKey: string) =>
    editor
        .getCurrentPageShapes()
        .find((s) => s.type === PROCESS_NODE_SHAPE_TYPE && (s.props as { nodeKey?: string }).nodeKey === nodeKey)!;

describe('what the inspector is told about a step', () => {
    it("names the step's kind, which the inspector keys every panel on", async () => {
        // It read `data.kind`, which a tldraw step never had, so the rule
        // panel and the per-kind link pickers never appeared on this canvas.
        const editor = await mount();
        const { result } = renderHook(() => useTldrawSelection(editor));
        act(() => editor.select(shapeOf(editor, 'a').id as TLShapeId));
        expect(result.current.node?.data).toMatchObject({ kind: 'action', ruleId: 'r1' });
    });

    it('a Trigger step is told the rules of the steps it leads to', async () => {
        const editor = await mount();
        const { result } = renderHook(() => useTldrawSelection(editor));
        act(() => editor.select(shapeOf(editor, 't').id as TLShapeId));
        expect(result.current.node?.data).toMatchObject({
            kind: 'trigger',
            fedRules: { ruleIds: ['r1'], unsavedOwners: 0 },
        });
    });
});

describe("a save's new rule ids reach the open canvas", () => {
    it('the step gets its rule, without marking the map dirty or adding an undo step', async () => {
        const onDirty = jest.fn();
        const editor = await mount({ onDirty });
        const undoBefore = editor.getCanUndo();

        let applied = 0;
        act(() => {
            applied = applySavedRuleIds(editor, [
                { nodeKey: 'a', dataJson: { ruleId: 'r1' } },
                { nodeKey: 'b', dataJson: { ruleId: 'r2' } },
            ]);
        });

        expect(applied).toBe(1);
        expect((shapeOf(editor, 'b').props as { dataJson: unknown }).dataJson).toEqual({ ruleId: 'r2' });
        // The server's answer is not an edit: no autosave, nothing to undo.
        expect(onDirty).not.toHaveBeenCalled();
        expect(editor.getCanUndo()).toBe(undoBefore);
    });
});

describe('"Open on canvas"', () => {
    it('selects the step it names', async () => {
        const editor = await mount({ focusNodeKey: 'b' });
        expect(editor.getSelectedShapeIds()).toEqual([shapeOf(editor, 'b').id]);
    });
});
