/**
 * @jest-environment jsdom
 *
 * An arrow drawn between two process nodes becomes a real edge.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * The tldraw canvas could not create an edge at all. `editor.createBindings`
 * was called from exactly one place — the load path — and the node shape
 * exposed no handles, so edges were materialised from saved rows and by nothing
 * else. Meanwhile `canBind()` returns true and `<Tldraw>` mounts with no
 * `hideUi`, so the default toolbar's arrow tool was live: a user could draw an
 * arrow between two steps that looked exactly like an edge, persisted to
 * `freeformJson` as annotation, and was invisible to every `ProcessEdge`
 * compliance query.
 *
 * Converting such an arrow fixes both halves at once, and borrows tldraw's own
 * targeting UX — `arrowTargetState` carries `snapDistance` and `snap` — which
 * is the proximity behaviour this canvas was otherwise missing.
 *
 * ── What is simulated and what is not ───────────────────────────────
 *
 * The arrow SHAPE and its two arrow BINDINGS are created programmatically,
 * which is what the arrow tool produces on pointer-up. The drag itself is not
 * simulated: tldraw's pointer pipeline needs real geometry and a measured
 * viewport, and the thing under test is the conversion, not tldraw's ability to
 * draw an arrow. `editor.inputs.isPointing` is false in a test, which is the
 * state the conversion waits for.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import { PROCESS_EDGE_SHAPE_TYPE } from '@/components/processes/tldraw/process-edge-shape';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { EdgeRefusal } from '@/components/processes/tldraw/edge-validation';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (nodeKey: string, nodeType: string, posX: number) => ({
    nodeKey, nodeType, label: nodeKey, subtitle: null,
    posX, posY: 0, parentNodeKey: null, dataJson: null,
});

const ROWS: GraphRows = {
    nodes: [
        node('a', 'processStep', 0),
        node('b', 'processStep', 400),
        node('note', 'annotation', 800),
    ],
    edges: [],
};

const refusals: EdgeRefusal[][] = [];

async function mount(rows: GraphRows = ROWS, readOnly = false): Promise<Editor> {
    refusals.length = 0;
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 900, height: 600 }}>
                <TldrawProcessCanvas
                    rows={rows}
                    readOnly={readOnly}
                    onEditorReady={(e) => (editor = e)}
                    onEdgeRefused={(r) => refusals.push(r)}
                />
            </div>,
        );
    });
    if (!editor) throw new Error('the host did not finish mounting');
    return editor;
}

/** Draw what the arrow tool produces: an arrow plus a binding at each end. */
async function drawArrow(
    editor: Editor,
    startNode: string | null,
    endNode: string | null,
): Promise<string> {
    const arrowId = `shape:arrow-${startNode}-${endNode}-${Math.random().toString(36).slice(2, 7)}`;
    await act(async () => {
        editor.createShapes([
            { id: arrowId as never, type: 'arrow', x: 0, y: 0, props: {} },
        ]);
        const bindings = [];
        if (startNode) {
            bindings.push({
                type: 'arrow',
                fromId: arrowId as never,
                toId: shapeIdForNodeKey(startNode) as never,
                props: { terminal: 'start', isPrecise: false, isExact: false,
                    normalizedAnchor: { x: 0.5, y: 0.5 } },
            });
        }
        if (endNode) {
            bindings.push({
                type: 'arrow',
                fromId: arrowId as never,
                toId: shapeIdForNodeKey(endNode) as never,
                props: { terminal: 'end', isPrecise: false, isExact: false,
                    normalizedAnchor: { x: 0.5, y: 0.5 } },
            });
        }
        if (bindings.length > 0) editor.createBindings(bindings as never);
    });
    return arrowId;
}

const processEdges = (editor: Editor) =>
    editor.store.allRecords().filter(
        (r) => r.typeName === 'binding' && (r as { type?: string }).type === PROCESS_EDGE_BINDING_TYPE,
    ) as unknown as Array<{ props: { edgeKey: string; sourceKey: string; targetKey: string } }>;

const lines = (editor: Editor) =>
    editor.store.allRecords().filter(
        (r) => r.typeName === 'shape' && (r as { type?: string }).type === PROCESS_EDGE_SHAPE_TYPE,
    );

const arrows = (editor: Editor) =>
    editor.store.allRecords().filter(
        (r) => r.typeName === 'shape' && (r as { type?: string }).type === 'arrow',
    );

describe('an arrow between two process nodes', () => {
    it('becomes a ProcessEdge binding with the drawn direction', async () => {
        const editor = await mount();
        expect(processEdges(editor)).toHaveLength(0);

        await drawArrow(editor, 'a', 'b');

        const edges = processEdges(editor);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.props.sourceKey).toBe('a');
        expect(edges[0]!.props.targetKey).toBe('b');
    });

    it('and the arrow itself is gone', async () => {
        // Left in place it would ALSO persist to freeformJson, so the map would
        // carry both a real edge and a lookalike drawing of the same thing.
        const editor = await mount();
        await drawArrow(editor, 'a', 'b');
        expect(arrows(editor)).toHaveLength(0);
    });

    it('and the derived line is drawn', async () => {
        // The binding util does NOT seed it — `repositionLine` returns early
        // when the shape is absent, documented there as the seeding case. On
        // load the serializer creates it; on a live draw the converter must.
        const editor = await mount();
        await drawArrow(editor, 'a', 'b');
        expect(lines(editor)).toHaveLength(1);
    });

    it('mints a key the line and the binding agree on', async () => {
        const editor = await mount();
        await drawArrow(editor, 'a', 'b');
        const key = processEdges(editor)[0]!.props.edgeKey;
        expect(String(lines(editor)[0]!.id)).toContain(key);
    });
});

describe('an arrow that is NOT an edge is left alone', () => {
    it('one bound end stays an annotation', async () => {
        const editor = await mount();
        await drawArrow(editor, 'a', null);
        expect(processEdges(editor)).toHaveLength(0);
        // AND the arrow survives — this is the half that makes the annotation
        // layer a feature rather than a silent deletion.
        expect(arrows(editor)).toHaveLength(1);
    });

    it('no bound ends stays an annotation', async () => {
        const editor = await mount();
        await drawArrow(editor, null, null);
        expect(processEdges(editor)).toHaveLength(0);
        expect(arrows(editor)).toHaveLength(1);
    });
});

describe('an arrow between two nodes that cannot take an edge', () => {
    it('is refused, the arrow survives, and the host is told why', async () => {
        const editor = await mount();
        await drawArrow(editor, 'a', 'note');

        expect(processEdges(editor)).toHaveLength(0);
        // The arrow is NOT deleted on refusal: the user's drawing is theirs,
        // and removing it would make the refusal indistinguishable from a bug.
        expect(arrows(editor)).toHaveLength(1);
        expect(refusals).toHaveLength(1);
        expect(refusals[0]!.map((r) => r.code)).toContain('NODE_IS_ANNOTATION');
    });

    it('refuses a duplicate of an edge already on the map', async () => {
        const editor = await mount();
        await drawArrow(editor, 'a', 'b');
        expect(processEdges(editor)).toHaveLength(1);

        await drawArrow(editor, 'a', 'b');
        // Still one, and the second attempt reported why.
        expect(processEdges(editor)).toHaveLength(1);
        expect(refusals.at(-1)!.map((r) => r.code)).toContain('DUPLICATE_EDGE');
    });

    it('refuses a self-loop', async () => {
        const editor = await mount();
        await drawArrow(editor, 'a', 'a');
        expect(processEdges(editor)).toHaveLength(0);
        expect(refusals.at(-1)!.map((r) => r.code)).toContain('SELF_LOOP');
    });
});

describe('read-only', () => {
    it('does not convert, because a reader cannot draw', async () => {
        // The handler is not installed at all on a read-only canvas. Teeth for
        // the install being conditional rather than the write being refused
        // somewhere deeper.
        const editor = await mount(ROWS, true);
        await drawArrow(editor, 'a', 'b');
        expect(processEdges(editor)).toHaveLength(0);
    });
});
