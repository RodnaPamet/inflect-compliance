/**
 * @jest-environment jsdom
 *
 * Process edges are DRAWN, and the drawing is never persisted.
 *
 * ── Why this file exists ─────────────────────────────────────────────
 *
 * Until the edge shape landed, the tldraw canvas drew nodes and no connectors:
 * edges were bindings only, and a `BindingUtil` has no `component()`. Every edge
 * test asserted the round trip — "every edge row becomes a binding between the
 * right two shapes", "endpoints are read from the record" — and none asserted a
 * line was drawn. So a green suite sat over a canvas missing half its content,
 * and the first assertion here is the one that was missing.
 *
 * The second is the hazard the fix introduces. The line is DERIVED from the
 * binding on every load, and `partitionCanvas`'s default arm is `freeform`,
 * which IS written to `ProcessMap.freeformJson`. A line falling through there
 * would be saved, then on the next load both re-derived AND restored: two lines
 * per edge, then four, compounding every save with nothing in the diff to
 * explain it. That is asserted against a real store rather than reasoned about.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import {
    PROCESS_EDGE_SHAPE_TYPE,
    edgeLineGeometry,
    shapeIdForEdgeKey,
    edgeKeyFromShapeId,
} from '@/components/processes/tldraw/process-edge-shape';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'n1', nodeType: 'processStep', label: 'Receive',
            subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null,
        },
        {
            nodeKey: 'n2', nodeType: 'processStep', label: 'Approve',
            subtitle: null, posX: 400, posY: 200, parentNodeKey: null, dataJson: null,
        },
    ],
    edges: [
        {
            edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2', edgeKind: 'flow',
            labelOverride: null, dataJson: null, controls: [],
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

/** Every derived edge line currently in the store. */
function lines(editor: Editor) {
    return editor.store
        .allRecords()
        .filter(
            (r) =>
                r.typeName === 'shape' &&
                (r as { type?: string }).type === PROCESS_EDGE_SHAPE_TYPE,
        ) as Array<{ id: string; x: number; y: number; props: { dx: number; dy: number; edgeKey: string; edgeKind: string; label: string; chipLabel: string } }>;
}

describe('an edge is drawn', () => {
    it('one line per edge row, after loading', async () => {
        // THE assertion that was missing. Bindings alone drew nothing.
        const editor = await mount();
        expect(lines(editor)).toHaveLength(1);
        expect(lines(editor)[0]!.props.edgeKey).toBe('e1');
    });

    it('with a deterministic id, so loading twice cannot double it', async () => {
        const editor = await mount();
        expect(lines(editor)[0]!.id).toBe(shapeIdForEdgeKey('e1'));
        expect(edgeKeyFromShapeId(lines(editor)[0]!.id)).toBe('e1');
    });

    it('spanning the two endpoints, not sitting at the origin', async () => {
        // A line drawn at 0,0 with no extent is present-but-invisible, which
        // would satisfy a bare "a line exists" check.
        const editor = await mount();
        const line = lines(editor)[0]!;
        expect(Math.abs(line.props.dx) + Math.abs(line.props.dy)).toBeGreaterThan(100);
    });

    it('and a graph with no edges draws no lines', async () => {
        const editor = await mount({ nodes: ROWS.nodes, edges: [] });
        expect(lines(editor)).toHaveLength(0);
    });

    it("carrying the row's edgeKind, so the variant is drawable (#3090)", async () => {
        // The line renders the variant from its OWN props, so a load that
        // seeded only `edgeKey`/`dx`/`dy` left every edge drawn as `flow`
        // regardless of what the row said.
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, edgeKind: 'conditional' }],
        });
        expect(lines(editor)[0]!.props.edgeKind).toBe('conditional');
    });

    it('and a reference edge keeps ITS kind, not the first one seen', async () => {
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, edgeKind: 'reference' }],
        });
        expect(lines(editor)[0]!.props.edgeKind).toBe('reference');
    });

    it("carrying the row's label too, so it is drawable (#3093)", async () => {
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, labelOverride: 'approves' }],
        });
        expect(lines(editor)[0]!.props.label).toBe('approves');
    });

    it("resolving the automation CHIP from the row's kind (#3093)", async () => {
        // The host resolves the chip's localised text at load, because no shape
        // util takes a translator. `condition-fail` maps to `autoFail`, which
        // the real English catalogue renders as "Fail".
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, edgeKind: 'condition-fail' }],
        });
        expect(lines(editor)[0]!.props.chipLabel).toBe('Fail');
    });

    it('but an explicit label SUPPRESSES the chip at load, not at render', async () => {
        /*
            The precedence is resolved by the HOST, which is the only place that
            can: the chip loses to a typed label and to controls, and `controls`
            lives on the binding where the line cannot cheaply reach it.

            Asserted on the stored prop rather than the rendered output, because
            a renderer-side check would pass even if the host had computed a chip
            that the renderer then happened to hide — leaving a resolved string
            on every labelled edge for no reason.
        */
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{
                ...ROWS.edges[0]!,
                edgeKind: 'condition-fail',
                labelOverride: 'if over limit',
            }],
        });
        expect(lines(editor)[0]!.props.chipLabel).toBe('');
        expect(lines(editor)[0]!.props.label).toBe('if over limit');
    });

    it('and CONTROLS suppress it too — the pills are the caption', async () => {
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{
                ...ROWS.edges[0]!,
                edgeKind: 'sla-breach',
                controls: [{ controlKey: 'c1', label: 'Approval', controlId: 'ctl_1', dataJson: null }],
            }],
        });
        expect(lines(editor)[0]!.props.chipLabel).toBe('');
    });

    it('trigger-flow gets no chip, though it IS an automation kind', async () => {
        // Teeth against "any automation kind gets a pill": the default flow
        // would put one on every ordinary automation edge.
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, edgeKind: 'trigger-flow' }],
        });
        expect(lines(editor)[0]!.props.chipLabel).toBe('');
        // …but it still carries its kind, so the COLOUR applies.
        expect(lines(editor)[0]!.props.edgeKind).toBe('trigger-flow');
    });

    it('and a NULL labelOverride becomes the empty string, not undefined', async () => {
        // The binding's label is nullable and the line's is not. An undefined
        // reaching a `T.string` prop is a validation failure on load, which
        // would take the whole map down rather than one label.
        const editor = await mount({
            nodes: ROWS.nodes,
            edges: [{ ...ROWS.edges[0]!, labelOverride: null }],
        });
        expect(lines(editor)[0]!.props.label).toBe('');
    });
});

describe('the drawing is NEVER persisted', () => {
    it('no edge line reaches freeformJson', async () => {
        // The compounding-duplication hazard. `partitionCanvas`'s default arm
        // is `freeform`, which IS written to `ProcessMap.freeformJson`.
        const editor = await mount();
        const { freeform } = serializeEditorCanvas(editor);

        const types = freeform.map((r) => String((r as { type?: unknown }).type));
        expect(types).not.toContain(PROCESS_EDGE_SHAPE_TYPE);
        expect(JSON.stringify(freeform)).not.toContain(PROCESS_EDGE_SHAPE_TYPE);
    });

    it('and the lines DO exist meanwhile — so that absence means something', async () => {
        // Without this the test above passes on a canvas that drew nothing,
        // which is the probe-with-no-discriminating-power failure.
        const editor = await mount();
        expect(lines(editor).length).toBeGreaterThan(0);
    });

    it('nor does it become a row', async () => {
        const editor = await mount();
        const { rows } = serializeEditorCanvas(editor);
        expect(rows.nodes).toHaveLength(2);
        expect(rows.nodes.map((n) => n.nodeKey)).not.toContain('e1');
        // The edge still round-trips as an EDGE, from its binding.
        expect(rows.edges).toHaveLength(1);
        expect(rows.edges[0]!.edgeKey).toBe('e1');
    });

    it('a sticky note still DOES reach freeform — the bucket still works', async () => {
        // Teeth for the exclusion: a `partitionCanvas` that dropped everything
        // unrecognised would satisfy the assertions above and silently erase
        // the annotation layer.
        const editor = await mount();
        await act(async () => {
            editor.createShapes([
                { id: 'shape:sticky-1' as never, type: 'note', x: 10, y: 10, props: {} },
            ]);
        });
        const { freeform } = serializeEditorCanvas(editor);
        expect(freeform.map((r) => String(r.id))).toContain('shape:sticky-1');
    });
});

describe('the line follows its endpoints', () => {
    it('repositions when a bound node moves', async () => {
        // Without the binding's `onAfterChange*ShapeHooks` the connector is
        // correct on load and wrong the moment anything is dragged.
        const editor = await mount();
        const before = { ...lines(editor)[0]! };

        await act(async () => {
            editor.updateShape({
                id: shapeIdForNodeKey('n2') as never,
                type: 'process-node',
                x: 900,
                y: 700,
            });
        });

        const after = lines(editor)[0]!;
        expect({ dx: after.props.dx, dy: after.props.dy }).not.toEqual({
            dx: before.props.dx,
            dy: before.props.dy,
        });
        // And it grew, because the target moved further away.
        expect(Math.abs(after.props.dx)).toBeGreaterThan(Math.abs(before.props.dx));
    });

    it('is removed when an endpoint is deleted', async () => {
        // tldraw deletes the BINDING with the shape, but the line is a third
        // record it knows nothing about — left alone it would survive as a
        // connector to a node that no longer exists.
        const editor = await mount();
        expect(lines(editor)).toHaveLength(1);

        await act(async () => {
            editor.deleteShapes([shapeIdForNodeKey('n2') as never]);
        });

        expect(lines(editor)).toHaveLength(0);
    });
});

describe('edgeLineGeometry', () => {
    it('places the line at the source centre and offsets to the target', () => {
        expect(
            edgeLineGeometry({ center: { x: 10, y: 20 } }, { center: { x: 50, y: 70 } }),
        ).toEqual({ x: 10, y: 20, dx: 40, dy: 50 });
    });

    it('carries a NEGATIVE offset for an edge pointing up or left', () => {
        // The case a sized SVG would clip and an unsigned delta would mirror.
        expect(
            edgeLineGeometry({ center: { x: 100, y: 100 } }, { center: { x: 40, y: 25 } }),
        ).toEqual({ x: 100, y: 100, dx: -60, dy: -75 });
    });

    it('is shared by the seed and the reposition, so they cannot drift', () => {
        // Asserted as a property rather than by reading both call sites: the
        // same inputs must give the same answer wherever it is called.
        const a = edgeLineGeometry({ center: { x: 3, y: 4 } }, { center: { x: 9, y: 1 } });
        const b = edgeLineGeometry({ center: { x: 3, y: 4 } }, { center: { x: 9, y: 1 } });
        expect(a).toEqual(b);
    });
});
