/**
 * @jest-environment jsdom
 *
 * A duplicated connection belongs to the duplicated steps (#5309 item 24).
 *
 * ── The defect ──────────────────────────────────────────────────────
 *
 * Ctrl+D on two connected steps A→B re-minted the copies' `nodeKey`s, and
 * tldraw copied the binding between them as A'→B' with a fresh `edgeKey` — but
 * the copied binding's `sourceKey` / `targetKey` still named A and B, and no
 * line was drawn for it. So the copies looked unconnected. A user who then drew
 * A'→B' met an arrow converter whose duplicate check read the copy as A→B, let
 * a second A'→B' binding through, and every save after that threw
 * `EdgeEndpointError DUPLICATE_EDGE` from `tldrawToRows`, which resolves both
 * through the shapes. Autosave could not persist the map until the user found
 * and deleted an edge they could not see.
 *
 * ── What is simulated ───────────────────────────────────────────────
 *
 * The duplicate is `editor.duplicateShapes`, which is what Ctrl+D and the menu
 * call. The arrow is created as the arrow tool leaves it on pointer-up, as in
 * `tldraw-arrow-becomes-an-edge.test.tsx`.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor, TLShapeId } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import { drillEdgesFrom, edgeEndpointIndex } from '@/components/processes/tldraw/drill-scope-host';
import type { EdgeRefusal } from '@/components/processes/tldraw/edge-validation';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    shapeIdForEdgeKey,
} from '@/components/processes/tldraw/process-edge-shape';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (nodeKey: string, nodeType: string, posX: number) => ({
    nodeKey,
    nodeType,
    label: nodeKey,
    subtitle: null,
    posX,
    posY: 0,
    parentNodeKey: null,
    dataJson: null,
});

const edge = (edgeKey: string, sourceKey: string, targetKey: string, edgeKind = 'flow') => ({
    edgeKey,
    sourceKey,
    targetKey,
    edgeKind,
    labelOverride: null,
    controls: [],
    dataJson: null,
});

const A_TO_B: GraphRows = {
    nodes: [node('a', 'processStep', 0), node('b', 'processStep', 400)],
    edges: [edge('e1', 'a', 'b')],
};

const refusals: EdgeRefusal[][] = [];

async function mount(rows: GraphRows = A_TO_B): Promise<Editor> {
    refusals.length = 0;
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 1000, height: 700 }}>
                <TldrawProcessCanvas
                    rows={rows}
                    onEditorReady={(e) => (editor = e)}
                    onEdgeRefused={(r) => refusals.push(r)}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the canvas did not mount');
    return editor;
}

type Step = { id: TLShapeId; x: number; props: { nodeKey: string } };
type EdgeBinding = {
    id: string;
    fromId: string;
    toId: string;
    props: { edgeKey: string; sourceKey: string; targetKey: string; edgeKind: string };
};
type Line = { id: string; props: { edgeKey: string; chipLabel: string } };

const steps = (editor: Editor) =>
    editor
        .getCurrentPageShapes()
        .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE) as unknown as Step[];

const edgeBindings = (editor: Editor) =>
    editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'binding' &&
                (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
        ) as unknown as EdgeBinding[];

const lines = (editor: Editor) =>
    editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'shape' &&
                (r as { type?: string }).type === PROCESS_EDGE_SHAPE_TYPE,
        ) as unknown as Line[];

/** Duplicate shapes the way Ctrl+D does, and return the new steps, left to right. */
async function duplicate(editor: Editor, ids: TLShapeId[]): Promise<[Step, Step]> {
    const before = new Set(steps(editor).map((s) => s.id));
    await act(async () => {
        editor.duplicateShapes(ids);
    });
    const copies = steps(editor)
        .filter((s) => !before.has(s.id))
        .sort((p, q) => p.x - q.x);
    expect(copies).toHaveLength(2);
    return [copies[0]!, copies[1]!];
}

/** The binding between two shapes, if any. */
const bindingBetween = (editor: Editor, from: Step, to: Step) =>
    edgeBindings(editor).filter((b) => b.fromId === from.id && b.toId === to.id);

/** Draw what the arrow tool leaves on pointer-up between two shapes. */
async function drawArrow(editor: Editor, from: TLShapeId, to: TLShapeId): Promise<void> {
    const arrowId = `shape:arrow-${Math.random().toString(36).slice(2, 9)}`;
    const end = (terminal: 'start' | 'end', toId: TLShapeId) => ({
        type: 'arrow',
        fromId: arrowId,
        toId,
        props: { terminal, isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
    });
    await act(async () => {
        editor.createShapes([{ id: arrowId as never, type: 'arrow', x: 0, y: 0, props: {} }]);
        editor.createBindings([end('start', from), end('end', to)] as never);
    });
}

const originals = (editor: Editor) =>
    steps(editor)
        .filter((s) => s.props.nodeKey === 'a' || s.props.nodeKey === 'b')
        .map((s) => s.id);

describe('Ctrl+D on two connected steps', () => {
    it('the copied binding names the COPIES, and has a line of its own', async () => {
        const editor = await mount();
        const [a2, b2] = await duplicate(editor, originals(editor));

        const copied = bindingBetween(editor, a2, b2);
        expect(copied).toHaveLength(1);
        expect(copied[0]!.props.sourceKey).toBe(a2.props.nodeKey);
        expect(copied[0]!.props.targetKey).toBe(b2.props.nodeKey);

        // One line per edge, each at the id derived from its own key.
        const lineIds = lines(editor).map((l) => l.id).sort();
        expect(lineIds).toEqual(
            edgeBindings(editor).map((b) => shapeIdForEdgeKey(b.props.edgeKey)).sort(),
        );
        expect(editor.getShape(shapeIdForEdgeKey(copied[0]!.props.edgeKey))).toBeDefined();
    });

    it('a copied automation edge keeps its kind and its chip', async () => {
        const en = require('../../messages/en.json') as {
            automation: { edges: Record<string, string> };
        };
        const editor = await mount({
            nodes: [node('a', 'action', 0), node('b', 'action', 400)],
            edges: [edge('e1', 'a', 'b', 'chain-delay')],
        });
        const [a2, b2] = await duplicate(editor, originals(editor));
        const copied = bindingBetween(editor, a2, b2)[0]!;
        const line = editor.getShape(shapeIdForEdgeKey(copied.props.edgeKey)) as unknown as
            | { props: { edgeKind: string; chipLabel: string } }
            | undefined;
        expect(line?.props.edgeKind).toBe('chain-delay');
        expect(line?.props.chipLabel).toBe(en.automation.edges.autoChain);
    });

    it('drawing the copies’ edge again is refused as a duplicate and adds nothing', async () => {
        const editor = await mount();
        const [a2, b2] = await duplicate(editor, originals(editor));
        const bindingsBefore = edgeBindings(editor).length;

        await drawArrow(editor, a2.id, b2.id);

        expect(edgeBindings(editor)).toHaveLength(bindingsBefore);
        expect(bindingBetween(editor, a2, b2)).toHaveLength(1);
        expect(refusals.flat().map((r) => r.code)).toEqual(['DUPLICATE_EDGE']);
    });

    it('the map still serialises afterwards: two edges, no DUPLICATE_EDGE', async () => {
        const editor = await mount();
        const [a2, b2] = await duplicate(editor, originals(editor));
        await drawArrow(editor, a2.id, b2.id);

        const rows = serializeEditorCanvas(editor).rows;
        expect(rows.edges.map((e) => `${e.sourceKey}->${e.targetKey}`).sort()).toEqual(
            ['a->b', `${a2.props.nodeKey}->${b2.props.nodeKey}`].sort(),
        );
    });

    it('with the line selected too, the copied line is not left behind as a stray', async () => {
        const editor = await mount();
        await act(async () => {
            editor.duplicateShapes(editor.getCurrentPageShapes().map((s) => s.id));
        });
        // Two edges, two lines — and every line at its binding's derived id.
        expect(edgeBindings(editor)).toHaveLength(2);
        expect(lines(editor).map((l) => l.id).sort()).toEqual(
            edgeBindings(editor).map((b) => shapeIdForEdgeKey(b.props.edgeKey)).sort(),
        );
    });

    it('one undo takes back the copies, their edge and its line', async () => {
        const editor = await mount();
        const [a2, b2] = await duplicate(editor, originals(editor));
        const copied = bindingBetween(editor, a2, b2)[0]!;
        const copiedLine = shapeIdForEdgeKey(copied.props.edgeKey);
        expect(editor.getShape(copiedLine)).toBeDefined();

        await act(async () => {
            editor.undo();
        });

        expect(editor.getShape(a2.id)).toBeUndefined();
        expect(editor.getShape(copiedLine)).toBeUndefined();
        expect(edgeBindings(editor).map((b) => b.props.edgeKey)).toEqual(['e1']);
        expect(lines(editor).map((l) => l.id)).toEqual([shapeIdForEdgeKey('e1')]);
    });
});

/**
 * The readers resolve endpoints through the bound shapes, as the save does,
 * whatever the props say. The props are made stale AFTER creation with
 * `updateBinding`, so this holds the readers on their own and not only the
 * create-time rewiring above.
 */
describe('an edge whose stored keys disagree with the shapes it binds', () => {
    async function staleCopy(): Promise<{ editor: Editor; a2: Step; b2: Step }> {
        const editor = await mount();
        const [a2, b2] = await duplicate(editor, originals(editor));
        const copied = bindingBetween(editor, a2, b2)[0]!;
        await act(async () => {
            editor.updateBinding({
                id: copied.id,
                type: PROCESS_EDGE_BINDING_TYPE,
                props: { sourceKey: 'a', targetKey: 'b' },
            } as never);
        });
        expect(bindingBetween(editor, a2, b2)[0]!.props.sourceKey).toBe('a');
        return { editor, a2, b2 };
    }

    it('the arrow converter’s duplicate check reads the shapes', async () => {
        const { editor, a2, b2 } = await staleCopy();
        await drawArrow(editor, a2.id, b2.id);
        expect(bindingBetween(editor, a2, b2)).toHaveLength(1);
        expect(refusals.flat().map((r) => r.code)).toEqual(['DUPLICATE_EDGE']);
    });

    it('the drill filter and the visibility index read the shapes', async () => {
        const { editor, a2, b2 } = await staleCopy();
        const pair = { source: a2.props.nodeKey, target: b2.props.nodeKey };
        const copied = bindingBetween(editor, a2, b2)[0]!;
        expect(edgeEndpointIndex(editor).get(copied.props.edgeKey)).toEqual(pair);
        expect(drillEdgesFrom(editor)).toContainEqual(pair);
    });
});

describe('the load and arrow paths are unchanged', () => {
    it('a loaded map: its keys as saved, one line per edge', async () => {
        const editor = await mount();
        expect(
            edgeBindings(editor).map((b) => [b.props.edgeKey, b.props.sourceKey, b.props.targetKey]),
        ).toEqual([['e1', 'a', 'b']]);
        expect(lines(editor).map((l) => l.id)).toEqual([shapeIdForEdgeKey('e1')]);
    });

    it('a drawn edge: one binding, one line at its key, endpoints from the arrow', async () => {
        const editor = await mount({
            nodes: [node('a', 'processStep', 0), node('b', 'processStep', 400)],
            edges: [],
        });
        const [a, b] = steps(editor).sort((p, q) => p.x - q.x);
        await drawArrow(editor, a!.id, b!.id);
        const drawn = edgeBindings(editor);
        expect(drawn).toHaveLength(1);
        expect([drawn[0]!.props.sourceKey, drawn[0]!.props.targetKey]).toEqual(['a', 'b']);
        expect(lines(editor).map((l) => l.id)).toEqual([shapeIdForEdgeKey(drawn[0]!.props.edgeKey)]);
        expect(refusals).toEqual([]);
    });
});
