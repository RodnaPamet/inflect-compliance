/**
 * @jest-environment jsdom
 *
 * What the tldraw canvas lets a user create, and what it keeps.
 *
 * Four defects, each one a way work vanished or a save started failing:
 *
 *   • A clicked palette item did nothing. Drag was the only way in, and HTML5
 *     drag never fires on a touch screen or from a keyboard.
 *   • A duplicated step (Ctrl+D, Alt-drag, copy and paste) carried its
 *     source's `nodeKey`, and the unique index on `(processMapId, nodeKey)`
 *     then refused every save of the map.
 *   • Notes, text, drawings and frames were SAVED to `freeformJson` and never
 *     loaded back, so each reload lost them and the next save erased them.
 *   • A step inside a frame was saved at frame-relative coordinates, and came
 *     back somewhere else on the page.
 *
 * And the tldraw interface offered things the map cannot keep: extra pages,
 * images and embeds, tldraw's own groups.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import { createShapeId, type Editor, type TLShapeId } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import {
    createProcessNode,
    placementForClick,
} from '@/components/processes/tldraw/create-process-node';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { FreeformRecord, GraphRows } from '@/components/processes/tldraw/serializer';

const node = (nodeKey: string, posX: number, posY: number) => ({
    nodeKey,
    nodeType: 'processStep',
    label: nodeKey,
    subtitle: null,
    posX,
    posY,
    parentNodeKey: null,
    dataJson: null,
});

const TWO_CONNECTED: GraphRows = {
    nodes: [node('n1', 0, 0), node('n2', 400, 0)],
    edges: [
        {
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            edgeKind: 'flow',
            labelOverride: null,
            controls: [],
            dataJson: null,
        },
    ],
};

async function mount(
    rows: GraphRows = { nodes: [], edges: [] },
    freeform: FreeformRecord[] = [],
): Promise<{ editor: Editor; unmount: () => void }> {
    let editor: Editor | undefined;
    let unmount!: () => void;
    await act(async () => {
        ({ unmount } = render(
            <div style={{ width: 1000, height: 700 }}>
                <TldrawProcessCanvas
                    rows={rows}
                    freeform={freeform}
                    onEditorReady={(e) => (editor = e)}
                />
            </div>,
        ));
    });
    if (!editor) throw new Error('the canvas did not mount');
    return { editor, unmount };
}

const stepShapes = (editor: Editor) =>
    editor
        .getCurrentPageShapes()
        .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE) as Array<{
        id: TLShapeId;
        x: number;
        y: number;
        props: { nodeKey: string; parentNodeKey: string | null };
    }>;

describe('a clicked palette item', () => {
    it('lands a step in the middle of the view', async () => {
        const { editor } = await mount();
        const view = editor.getViewportPageBounds();
        await act(async () => {
            createProcessNode(editor, {
                kind: 'risk',
                label: 'Risk',
                point: placementForClick(editor),
                parentNodeKey: null,
            });
        });
        const [step] = stepShapes(editor);
        expect(step).toBeDefined();
        // Centred on the view: jsdom's viewport is smaller than a step, so
        // "inside the view" cannot be asserted here, but the centre can.
        const bounds = editor.getShapePageBounds(step!.id)!;
        expect(bounds.center.x).toBeCloseTo(view.center.x);
        expect(bounds.center.y).toBeCloseTo(view.center.y);
    });

    it('clicked twice gives two visible steps, not one stacked on the other', async () => {
        const { editor } = await mount();
        await act(async () => {
            for (let i = 0; i < 2; i++) {
                createProcessNode(editor, {
                    kind: 'processStep',
                    label: 'Step',
                    point: placementForClick(editor),
                    parentNodeKey: null,
                });
            }
        });
        const [a, b] = stepShapes(editor);
        expect(a && b).toBeTruthy();
        expect(`${a!.x}:${a!.y}`).not.toBe(`${b!.x}:${b!.y}`);
        expect(a!.props.nodeKey).not.toBe(b!.props.nodeKey);
    });
});

describe('a duplicated step gets its OWN key', () => {
    it('Ctrl+D on a step mints a fresh nodeKey', async () => {
        const { editor } = await mount({ nodes: [node('n1', 0, 0)], edges: [] });
        const [source] = stepShapes(editor);
        await act(async () => {
            editor.duplicateShapes([source!.id]);
        });
        const keys = stepShapes(editor).map((s) => s.props.nodeKey);
        expect(keys).toHaveLength(2);
        expect(new Set(keys).size).toBe(2);
        // And the map still serialises: two rows, two keys.
        const rows = serializeEditorCanvas(editor).rows;
        expect(new Set(rows.nodes.map((n) => n.nodeKey)).size).toBe(2);
    });

    it('a copied connection gets its own edgeKey too', async () => {
        const { editor } = await mount(TWO_CONNECTED);
        await act(async () => {
            editor.duplicateShapes(stepShapes(editor).map((s) => s.id));
        });
        const edgeKeys = editor.store
            .allRecords()
            .filter(
                (r) =>
                    r.typeName === 'binding' &&
                    (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
            )
            .map((r) => (r as unknown as { props: { edgeKey: string } }).props.edgeKey);
        // Whether tldraw copies a custom binding is tldraw's choice; what must
        // never happen is two bindings sharing a key.
        expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
    });

    it('teeth: a step created with a key nobody holds keeps it', async () => {
        const { editor } = await mount({ nodes: [node('n1', 0, 0)], edges: [] });
        await act(async () => {
            editor.createShape({
                id: createShapeId('fresh'),
                type: PROCESS_NODE_SHAPE_TYPE,
                x: 500,
                y: 500,
                props: { nodeKey: 'n-unique', nodeType: 'processStep', label: 'x' },
            });
        });
        expect(stepShapes(editor).map((s) => s.props.nodeKey).sort()).toEqual(['n-unique', 'n1']);
    });
});

describe('the freeform layer comes back after a reload', () => {
    it('a note saved with the map is on the canvas when it is opened again', async () => {
        const first = await mount({ nodes: [node('n1', 0, 0)], edges: [] });
        await act(async () => {
            first.editor.createShape({
                id: createShapeId('note-1'),
                type: 'note',
                x: 640,
                y: 120,
            });
        });
        const saved = serializeEditorCanvas(first.editor).freeform;
        expect(saved.some((r) => r.type === 'note')).toBe(true);
        first.unmount();

        const second = await mount({ nodes: [node('n1', 0, 0)], edges: [] }, saved);
        const note = second.editor.getShape(createShapeId('note-1'));
        expect(note).toBeDefined();
        expect(note!.x).toBe(640);
        expect(note!.y).toBe(120);
        // And it stays freeform: no row for it.
        expect(serializeEditorCanvas(second.editor).rows.nodes).toHaveLength(1);
    });

    it('a record tldraw refuses is skipped rather than taking the map down', async () => {
        const { editor } = await mount({ nodes: [node('n1', 0, 0)], edges: [] }, [
            { id: 'shape:bogus', type: 'not-a-shape-type', typeName: 'shape' },
        ]);
        expect(stepShapes(editor)).toHaveLength(1);
    });
});

describe('a step inside a frame', () => {
    it('is saved at its PAGE position, where the row will put it back', async () => {
        const { editor } = await mount({ nodes: [node('n1', 300, 300)], edges: [] });
        const frameId = createShapeId('frame-1');
        const [step] = stepShapes(editor);
        await act(async () => {
            editor.createShape({ id: frameId, type: 'frame', x: 200, y: 200, props: { w: 600, h: 400 } });
            editor.reparentShapes([step!.id], frameId);
        });
        // tldraw now stores it relative to the frame…
        expect(editor.getShape(step!.id)!.parentId).toBe(frameId);
        // …and the row still says where it is on the page.
        const row = serializeEditorCanvas(editor).rows.nodes.find((n) => n.nodeKey === 'n1')!;
        expect(row.posX).toBeCloseTo(300);
        expect(row.posY).toBeCloseTo(300);
    });
});

describe('what the map cannot keep is not offered', () => {
    it('one page only', async () => {
        const { editor } = await mount();
        expect(editor.options.maxPages).toBe(1);
    });
});
