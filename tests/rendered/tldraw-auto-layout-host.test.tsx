/**
 * @jest-environment jsdom
 *
 * Auto-layout, driven from a real tldraw store.
 *
 * ── Why a rendered test and not a unit test ─────────────────────────
 *
 * The ENGINE is pure and already covered three ways over, against both xyflow
 * and structural input. What no engine test covers is the TRANSLATION: reading
 * process nodes out of a store, deciding what counts as an edge, and writing
 * positions back. That is where a port goes wrong, and it needs a store with
 * real shapes, real bindings and real page bounds.
 *
 * ── The trap this is mostly here to catch ───────────────────────────
 *
 * Layout must run in SHAPE id space, not `nodeKey` space. `updateShapes` needs
 * shape ids, and a node the user DREW has a random shape id whose `nodeKey`
 * lives only in its props. A `nodeKey`-keyed round trip looks correct on a
 * loaded map and silently skips every freshly drawn node — so there is a test
 * below for exactly that node.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import {
    applyLayout,
    layoutEdgesFrom,
    layoutNodesFrom,
    runAutoLayout,
    selectedNodeIds,
} from '@/components/processes/tldraw/auto-layout-host';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (nodeKey: string, nodeType: string, posX: number, posY = 0) => ({
    nodeKey, nodeType, label: nodeKey, subtitle: null,
    posX, posY, parentNodeKey: null, dataJson: null,
});

/** A chain a -> b -> c, plus a floating annotation. */
const ROWS: GraphRows = {
    nodes: [
        node('a', 'processStep', 0, 0),
        node('b', 'processStep', 10, 0),
        node('c', 'processStep', 20, 0),
        node('note', 'annotation', 500, 500),
    ],
    edges: [
        { edgeKey: 'e1', sourceKey: 'a', targetKey: 'b', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
        { edgeKey: 'e2', sourceKey: 'b', targetKey: 'c', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
    ],
};

async function mount(rows: GraphRows = ROWS): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 900, height: 700 }}>
                <TldrawProcessCanvas rows={rows} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the host did not finish mounting');
    return editor;
}

const posOf = (editor: Editor, nodeKey: string) => {
    const s = editor.getShape(shapeIdForNodeKey(nodeKey) as never) as
        | { x: number; y: number }
        | undefined;
    if (!s) throw new Error(`no shape for ${nodeKey}`);
    return { x: s.x, y: s.y };
};

describe('reading the store', () => {
    it('collects process nodes with their kind and size', async () => {
        const editor = await mount();
        const nodes = layoutNodesFrom(editor);
        // Four shapes including the annotation — the ENGINE skips annotations,
        // not the reader. Filtering here would hide them from the engine's own
        // documented behaviour and make that skip untestable from this side.
        expect(nodes).toHaveLength(4);
        const kinds = nodes.map((n) => (n.data as { kind?: unknown }).kind);
        expect(kinds).toContain('processStep');
        expect(kinds).toContain('annotation');
        // A size the engine can use, rather than undefined falling back to the
        // engine's own default for every node.
        expect(nodes.every((n) => typeof n.style?.width === 'number')).toBe(true);
    });

    it('expresses edges in SHAPE ids, not node keys', async () => {
        const editor = await mount();
        const edges = layoutEdgesFrom(editor);
        expect(edges).toHaveLength(2);
        for (const e of edges) {
            expect(e.source.startsWith('shape:')).toBe(true);
            expect(e.target.startsWith('shape:')).toBe(true);
        }
        // And they are the ids layout will write back to.
        const ids = new Set(layoutNodesFrom(editor).map((n) => n.id));
        expect(edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    });

    it('drops a binding whose endpoint is not on the page', () => {
        /**
         * Against a FAKE store, and that is the point.
         *
         * The first version of this test deleted node `c` from a real editor
         * and asserted one edge remained. It passed, and it proved nothing:
         * tldraw removes bindings involving a deleted shape, so the binding was
         * already gone and the filter had nothing to filter. The mutation proof
         * caught it — deleting the filter entirely left all thirteen tests
         * green.
         *
         * The case the filter actually exists for is reachable because the two
         * reads have different scopes: `store.allRecords()` is store-wide while
         * `getCurrentPageShapes()` is page-scoped, so a binding on another page
         * is visible to the first and absent from the second. dagre given an
         * edge to an unknown node invents a rank for it and shifts everything
         * else to accommodate a node nobody can see.
         *
         * A fake store is the honest way to construct that: building a real
         * second page would test tldraw's page model, not this filter.
         */
        const fake = {
            getCurrentPageShapes: () => [{ id: 'shape:a' }, { id: 'shape:b' }],
            store: {
                allRecords: () => [
                    { typeName: 'binding', type: 'process-edge', id: 'binding:1',
                      fromId: 'shape:a', toId: 'shape:b' },
                    // Endpoint on another page.
                    { typeName: 'binding', type: 'process-edge', id: 'binding:2',
                      fromId: 'shape:a', toId: 'shape:elsewhere' },
                ],
            },
        } as unknown as Editor;

        const edges = layoutEdgesFrom(fake);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.id).toBe('binding:1');
    });

    it('and keeps one whose endpoints ARE both on the page — teeth', () => {
        // Without this, a filter that dropped everything would satisfy the
        // assertion above.
        const fake = {
            getCurrentPageShapes: () => [{ id: 'shape:a' }, { id: 'shape:b' }],
            store: {
                allRecords: () => [
                    { typeName: 'binding', type: 'process-edge', id: 'binding:1',
                      fromId: 'shape:a', toId: 'shape:b' },
                ],
            },
        } as unknown as Editor;
        expect(layoutEdgesFrom(fake)).toHaveLength(1);
    });
});

describe('laying the graph out', () => {
    it('LR puts each step to the right of the one before it', async () => {
        const editor = await mount();
        const moved = runAutoLayout(editor, 'LR');
        expect(moved).toBeGreaterThan(0);
        expect(posOf(editor, 'b').x).toBeGreaterThan(posOf(editor, 'a').x);
        expect(posOf(editor, 'c').x).toBeGreaterThan(posOf(editor, 'b').x);
    });

    it('TB puts each step below the one before it', async () => {
        const editor = await mount();
        runAutoLayout(editor, 'TB');
        expect(posOf(editor, 'b').y).toBeGreaterThan(posOf(editor, 'a').y);
        expect(posOf(editor, 'c').y).toBeGreaterThan(posOf(editor, 'b').y);
    });

    it('leaves the annotation out of the flow', async () => {
        // The engine skips it. Asserted from here because the reader
        // deliberately passes it through, so this is the only place the two
        // halves are checked together.
        const editor = await mount();
        const before = posOf(editor, 'note');
        runAutoLayout(editor, 'LR');
        expect(posOf(editor, 'note')).toEqual(before);
    });

    it('lays out a node the user DREW, whose shape id is random', async () => {
        // THE trap. A `nodeKey`-keyed round trip passes every test above and
        // silently skips this node, because its shape id is not
        // `shapeIdForNodeKey(nodeKey)`.
        const editor = await mount();
        const drawnId = 'shape:drawn-xyz';
        await act(async () => {
            editor.createShapes([
                {
                    id: drawnId as never,
                    type: 'process-node',
                    x: 5,
                    y: 5,
                    props: { nodeKey: 'drawn-1', nodeType: 'processStep',
                        label: 'Drawn', subtitle: null, dataJson: null },
                },
            ]);
        });
        expect(layoutNodesFrom(editor).map((n) => n.id)).toContain(drawnId);

        runAutoLayout(editor, 'LR');
        const after = editor.getShape(drawnId as never) as { x: number; y: number };
        // It participated: dagre places every node it is given, and a node it
        // skipped would still sit at 5,5.
        expect({ x: after.x, y: after.y }).not.toEqual({ x: 5, y: 5 });
    });
});

describe('selection scope', () => {
    it('moves only the selected nodes', async () => {
        const editor = await mount();
        await act(async () => {
            editor.select(shapeIdForNodeKey('a') as never, shapeIdForNodeKey('b') as never);
        });
        expect(selectedNodeIds(editor).size).toBe(2);
        const cBefore = posOf(editor, 'c');

        const moved = runAutoLayout(editor, 'LR', 'selection');
        expect(moved).toBe(2);
        expect(posOf(editor, 'c')).toEqual(cBefore);
    });

    it('refuses fewer than two selected nodes', async () => {
        // Laying out ONE node moves it to the origin of its own private graph,
        // which looks like the node being flung away.
        const editor = await mount();
        await act(async () => {
            editor.select(shapeIdForNodeKey('a') as never);
        });
        const before = posOf(editor, 'a');
        expect(runAutoLayout(editor, 'LR', 'selection')).toBe(0);
        expect(posOf(editor, 'a')).toEqual(before);
    });

    it('and an empty selection moves nothing', async () => {
        const editor = await mount();
        const before = posOf(editor, 'a');
        expect(runAutoLayout(editor, 'LR', 'selection')).toBe(0);
        expect(posOf(editor, 'a')).toEqual(before);
    });
});

describe('applying positions', () => {
    it('reports how many nodes moved', async () => {
        const editor = await mount();
        expect(applyLayout(editor, { [String(shapeIdForNodeKey('a'))]: { x: 99, y: 99 } })).toBe(1);
        expect(posOf(editor, 'a')).toEqual({ x: 99, y: 99 });
    });

    it('an empty map is a no-op and marks no history', async () => {
        // Returning 0 rather than marking a stopping point: an undo entry that
        // undoes nothing is worse than no entry, because the user presses undo
        // and watches nothing happen.
        const editor = await mount();
        expect(applyLayout(editor, {})).toBe(0);
    });

    it('one undo step restores the whole layout', async () => {
        const editor = await mount();
        const before = posOf(editor, 'b');
        runAutoLayout(editor, 'LR');
        expect(posOf(editor, 'b')).not.toEqual(before);
        await act(async () => {
            editor.undo();
        });
        expect(posOf(editor, 'b')).toEqual(before);
    });
});
