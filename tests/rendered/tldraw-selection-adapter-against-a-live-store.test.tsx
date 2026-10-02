/**
 * @jest-environment jsdom
 *
 * The inspector's selection adapter, driven by a REAL tldraw store.
 *
 * ═══ THE GAP THIS FILLS (#3079) ═══
 *
 * `tldraw-selection-adapter.test.ts` covers the adapter thoroughly — against a
 * `fakeEditor` with hand-written `getSelectedShapes` / `allRecords` / `listen`.
 * That is the right instrument for the write path's branching, and it cannot
 * answer one question: whether the shapes a LIVE editor hands back have the
 * fields the adapter reads.
 *
 * The deleted xyflow canvas had that covered incidentally — its selection WAS
 * the component's own state, so any test rendering it exercised both. Here the
 * store is tldraw's, the adapter reads `props.nodeKey` and resolves a line back
 * through a binding, and nothing joined the two until now.
 *
 * ═══ WHY THE KEY, NOT THE ID — THE TRAP THIS PINS ═══
 *
 * `shapeIdForNodeKey` is deterministic, so for a node that came from a ROW the
 * shape id and the key are derivable from each other and a test can pass while
 * reading the wrong one. A node the user DREW has a random id and its key lives
 * only in its props. `use-tldraw-selection.ts` records that resolving by the
 * derived id made an inspector edit on a drawn node silently do nothing — the
 * lookup missed, the function returned early, no error surfaced.
 *
 * So the fixture deliberately includes a node whose id is NOT derived from its
 * key, and the assertions go through it.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { PROCESS_NODE_SHAPE_TYPE, shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import { shapeIdForEdgeKey } from '@/components/processes/tldraw/process-edge-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';
import { useTldrawSelection } from '@/lib/processes/use-tldraw-selection';

const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'n1', nodeType: 'processStep', label: 'Receive',
            subtitle: 'from the portal', posX: 0, posY: 0,
            parentNodeKey: null, dataJson: { linkedEntityId: 'ctl_7' },
        },
        {
            nodeKey: 'n2', nodeType: 'processStep', label: 'Approve',
            subtitle: null, posX: 400, posY: 200, parentNodeKey: null, dataJson: null,
        },
    ],
    edges: [
        {
            edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2', edgeKind: 'conditional',
            labelOverride: 'if over limit', dataJson: null, controls: [],
        },
    ],
};

async function liveEditor(): Promise<Editor> {
    let ed: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <TldrawProcessCanvas rows={ROWS} onEditorReady={(e) => (ed = e)} />
            </div>,
        );
    });
    if (!ed) throw new Error('the canvas did not finish mounting');
    return ed;
}

describe('a selected NODE reaches the inspector from a live store', () => {
    it('carries the KEY and the props the inspector reads', async () => {
        const editor = await liveEditor();
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => {
            editor.setSelectedShapes([shapeIdForNodeKey('n1') as never]);
        });
        // The id is the CONTRACT the inspector and the row both speak.
        expect(h.result.current.node?.id).toBe('n1');
        // And the fields it renders actually arrived off the live shape.
        const data = h.result.current.node?.data as Record<string, unknown> | undefined;
        expect(data?.label).toBe('Receive');
        expect(data?.subtitle).toBe('from the portal');
    });

    it('resolves a node whose shape id is NOT derived from its key', async () => {
        /*
            THE assertion. A node the user draws gets a random id; resolving by
            `shapeIdForNodeKey` would miss it and the inspector edit would do
            nothing, silently. Created here with an explicit id that bears no
            relation to its key.
        */
        const editor = await liveEditor();
        const drawnId = 'shape:drawn-xyz' as never;
        await act(async () => {
            editor.createShapes([
                {
                    id: drawnId,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: 20, y: 20,
                    props: {
                        nodeKey: 'drawn-1', nodeType: 'processStep',
                        label: 'Drawn', subtitle: null,
                        parentNodeKey: null, dataJson: null,
                    },
                } as never,
            ]);
        });
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => editor.setSelectedShapes([drawnId]));
        expect(h.result.current.node?.id).toBe('drawn-1');
        // Not the shape id, which is what a derived-id lookup would surface.
        expect(h.result.current.node?.id).not.toContain('shape:');
    });

    it('and an inspector edit lands on that drawn node', async () => {
        // The half the unit test cannot reach: the write has to FIND the shape.
        const editor = await liveEditor();
        const drawnId = 'shape:drawn-abc' as never;
        await act(async () => {
            editor.createShapes([
                {
                    id: drawnId,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: 20, y: 20,
                    props: {
                        nodeKey: 'drawn-2', nodeType: 'processStep',
                        label: 'Before', subtitle: null,
                        parentNodeKey: null, dataJson: null,
                    },
                } as never,
            ]);
        });
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => {
            h.result.current.onUpdate('drawn-2', { label: 'After' });
        });
        const shape = editor.getShape(drawnId) as unknown as
            | { props: { label: string } }
            | undefined;
        expect(shape?.props.label).toBe('After');
    });
});

describe('a selected LINE resolves through its binding', () => {
    it('surfaces the edge key, kind and label off the live binding', async () => {
        // The line carries geometry and a key; the BINDING holds the data. A
        // selection that stopped at the line would give the inspector an edge
        // with nothing to inspect.
        const editor = await liveEditor();
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => {
            editor.setSelectedShapes([shapeIdForEdgeKey('e1') as never]);
        });
        expect(h.result.current.edge?.id).toBe('e1');
        const data = h.result.current.edge?.data as Record<string, unknown> | undefined;
        expect(data?.edgeKind).toBe('conditional');
        expect(h.result.current.edge?.label).toBe('if over limit');
    });

    it('a node wins when a node and a line are both selected', async () => {
        // `resolveSelection`'s rule, asserted against a real multi-selection
        // rather than a hand-built array — the inspector shows one panel.
        const editor = await liveEditor();
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => {
            editor.setSelectedShapes([
                shapeIdForNodeKey('n1') as never,
                shapeIdForEdgeKey('e1') as never,
            ]);
        });
        expect(h.result.current.selection.kind).toBe('node');
    });
});

describe('selection is OBSERVED, not read once', () => {
    it('clearing the selection clears the inspector', async () => {
        // `getSelectedShapes()` is a read. Called once it goes stale and the
        // inspector shows whatever was selected when the component last
        // rendered for some other reason.
        const editor = await liveEditor();
        const h = renderHook(() => useTldrawSelection(editor));
        await act(async () => editor.setSelectedShapes([shapeIdForNodeKey('n1') as never]));
        expect(h.result.current.node).not.toBeNull();
        await act(async () => editor.setSelectedShapes([]));
        expect(h.result.current.node).toBeNull();
        expect(h.result.current.edge).toBeNull();
    });
});
