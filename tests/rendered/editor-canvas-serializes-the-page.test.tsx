/**
 * @jest-environment jsdom
 *
 * A live editor's page, projected to the save payload.
 *
 * ── What only a mounted editor can answer ────────────────────────────
 *
 * `serializer-round-trip` proves `tldrawToRows` handles the right plain
 * objects. It never sees a store, so it cannot see the two things that only
 * exist once one is involved:
 *
 *   1. **What `allRecords()` actually contains.** Camera, instance, pointer,
 *      page, document — and `partitionCanvas` puts anything it does not
 *      recognise into `freeform`, which is persisted to
 *      `ProcessMap.freeformJson`. Hand it the whole store and a save writes the
 *      user's camera position and pointer coordinates into the document, on
 *      every save, for the next load to faithfully restore.
 *   2. **Which page a shape is on.** A process map is one page; tldraw allows
 *      more. `allRecords()` spans them.
 *
 * Both are asserted here against a real store rather than reasoned about.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import {
    PROCESS_NODE_SHAPE_TYPE,
    shapeIdForNodeKey,
} from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'n1',
            nodeType: 'processStep',
            label: 'Receive invoice',
            subtitle: 'AP team',
            posX: 0,
            posY: 0,
            parentNodeKey: null,
            dataJson: null,
        },
        {
            nodeKey: 'n2',
            nodeType: 'decision',
            label: 'Over threshold?',
            subtitle: null,
            posX: -412.5,
            posY: 96.25,
            parentNodeKey: null,
            dataJson: { branchLabels: { yes: 'Escalate', no: 'Pay' } },
        },
    ],
    edges: [
        {
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            edgeKind: 'flow',
            labelOverride: null,
            dataJson: null,
            controls: [],
        },
    ],
};

async function mount(rows: GraphRows = ROWS): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <TldrawProcessCanvas rows={rows} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the host did not finish mounting');
    return editor;
}

describe('a loaded map serialises back to itself', () => {
    it('through a LIVE store, not a fixture', async () => {
        // The round trip the migration rests on, with an editor in the middle:
        // rows → shapes and bindings in a real store → rows.
        const editor = await mount();
        const { rows } = serializeEditorCanvas(editor);

        expect(rows.nodes).toHaveLength(2);
        expect(rows.nodes.map((n) => n.nodeKey).sort()).toEqual(['n1', 'n2']);
        expect(rows.edges).toHaveLength(1);
        expect(rows.edges[0]).toMatchObject({
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            edgeKind: 'flow',
        });
    });

    it('carries fractional and negative geometry unchanged', async () => {
        const editor = await mount();
        const { rows } = serializeEditorCanvas(editor);
        const n2 = rows.nodes.find((n) => n.nodeKey === 'n2');
        expect({ posX: n2?.posX, posY: n2?.posY }).toEqual({ posX: -412.5, posY: 96.25 });
    });

    it('and reflects an edit made on the canvas', async () => {
        // Teeth: a projection that returned the INPUT rows rather than reading
        // the store would satisfy both tests above.
        const editor = await mount();
        await act(async () => {
            editor.updateShape({
                id: editor.getCurrentPageShapes()[0]!.id,
                type: PROCESS_NODE_SHAPE_TYPE,
                props: { label: 'Edited on the canvas' },
            });
        });
        const { rows } = serializeEditorCanvas(editor);
        expect(rows.nodes.map((n) => n.label)).toContain('Edited on the canvas');
    });
});

describe('the session never reaches the document', () => {
    it('camera, pointer and instance records do NOT become freeform', async () => {
        // THE assertion. A mounted editor always holds these, so if the filter
        // were absent this would fail without anyone having to construct a
        // special case — which is why it is worth asserting against a live
        // store rather than a hand-built record list.
        const editor = await mount();
        await act(async () => {
            editor.setCamera({ x: 123, y: 456, z: 2 });
        });

        const { freeform } = serializeEditorCanvas(editor);
        const typeNames = freeform.map((r) => String((r as { typeName?: unknown }).typeName));

        expect(typeNames).not.toContain('camera');
        expect(typeNames).not.toContain('pointer');
        expect(typeNames).not.toContain('instance');
        expect(typeNames).not.toContain('instance_page_state');
        expect(typeNames).not.toContain('document');
        expect(typeNames).not.toContain('page');

        // And the camera's own numbers are nowhere in the payload.
        expect(JSON.stringify(freeform)).not.toContain('123');
    });

    it('the store DOES hold those records — so the absence above means something', async () => {
        // Without this the test above passes on an empty store, which is the
        // "a probe with no discriminating power" failure. The filter can only
        // be shown to work if there is something for it to filter.
        const editor = await mount();
        const all = editor.store.allRecords().map((r) => r.typeName);
        expect(all).toContain('camera');
        expect(all).toContain('instance');
        expect(all.filter((t) => t !== 'shape' && t !== 'binding').length).toBeGreaterThan(0);
    });
});

describe('only the CURRENT page becomes rows', () => {
    it('a process shape parked on a second page is not saved', async () => {
        // Measured as a real hazard, not a hypothetical: `createPage` is in the
        // default UI, and with a shape on page two `allRecords()` reports three
        // shapes while the current page has two. Reading the store instead of
        // the page would turn that shape into a row on a map it does not belong
        // to — and, since the id is minted from its nodeKey, quietly into a
        // node the user never put there.
        const editor = await mount();

        await act(async () => {
            editor.createPage({ name: 'Page 2' });
        });
        const pages = editor.getPages();
        expect(pages.length).toBe(2);

        await act(async () => {
            editor.setCurrentPage(pages[1]!.id);
        });
        await act(async () => {
            editor.createShapes([
                {
                    id: shapeIdForNodeKey('offpage') as never,
                    type: PROCESS_NODE_SHAPE_TYPE,
                    x: 0,
                    y: 0,
                    props: {
                        w: 220,
                        h: 88,
                        nodeKey: 'offpage',
                        nodeType: 'processStep',
                        label: 'Parked elsewhere',
                        subtitle: null,
                        parentNodeKey: null,
                        dataJson: null,
                    },
                },
            ]);
        });
        await act(async () => {
            editor.setCurrentPage(pages[0]!.id);
        });

        // The store now holds three process NODE shapes; the page holds two.
        //
        // Counted by node TYPE rather than by `typeName === 'shape'`. The raw
        // shape count also includes the derived edge lines, which exist because
        // a binding cannot render — so a total-shape count measures "how many
        // kinds of shape does the canvas have" and drifts whenever that answer
        // changes. The claim here is about process nodes and pages.
        expect(
            editor.store
                .allRecords()
                .filter(
                    (r) =>
                        r.typeName === 'shape' &&
                        (r as { type?: string }).type === PROCESS_NODE_SHAPE_TYPE,
                ),
        ).toHaveLength(3);

        const { rows } = serializeEditorCanvas(editor);
        expect(rows.nodes).toHaveLength(2);
        expect(rows.nodes.map((n) => n.nodeKey)).not.toContain('offpage');
    });
});

describe('the freeform layer still gets what belongs to it', () => {
    it('a sticky note is carried, and becomes no row', async () => {
        // The other direction: filtering the session out must not also drop the
        // annotation layer, which IS persisted — to `freeformJson`, never to
        // `ProcessNode`.
        const editor = await mount();
        await act(async () => {
            editor.createShapes([
                { id: 'shape:sticky-1' as never, type: 'note', x: 10, y: 10, props: {} },
            ]);
        });

        const { rows, freeform } = serializeEditorCanvas(editor);
        expect(rows.nodes.map((n) => n.nodeKey)).not.toContain('sticky-1');
        expect(freeform.map((r) => String(r.id))).toContain('shape:sticky-1');
    });
});
