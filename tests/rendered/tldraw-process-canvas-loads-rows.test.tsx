/**
 * @jest-environment jsdom
 *
 * The tldraw host loads rows into a live store, then locks it.
 *
 * ── What this covers that the serializer tests cannot ────────────────
 *
 * `serializer-round-trip.test.ts` proves `rowsToTldraw` produces the right
 * plain objects. It never puts them into an editor, so it cannot see the two
 * failures that only exist once a store is involved:
 *
 *   1. **A record the validators reject.** `createShapes` / `createBindings`
 *      run the same `ShapeUtil` / `BindingUtil` validators the live canvas
 *      would, so a serializer output that disagrees with
 *      `processNodeShapeProps` throws at load. A snapshot-seeded store would
 *      have accepted it silently — which is why the host seeds through the
 *      create calls and why that choice is asserted here rather than just
 *      commented.
 *
 *   2. **Ordering.** Read-only is set AFTER seeding, because `createShapes` is
 *      itself a write. Set it first and the canvas loads empty and reports
 *      nothing — the quietest possible version of this being wrong. The test
 *      for that is the conjunction: shapes present AND the store locked.
 *
 * ── Scope, deliberately narrow ───────────────────────────────────────
 *
 * The host carries no write path — no autosave, no history, no
 * `expectedVersion`, and nothing mounts it yet (`isProcessCanvasTldrawEnabled`
 * still has zero consumers). So there is nothing here about saving, and that
 * absence is the point: the read direction is verified on its own, where it
 * changes nothing for any tenant.
 *
 * jsdom has no canvas `getContext`, so nothing below asserts geometry — see
 * `tests/helpers/tldraw-jsdom.ts` for what this environment can and cannot
 * answer.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

// Before the tldraw import: the licence manager reaches for `fetch` during
// module evaluation.
installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import {
    PROCESS_NODE_SHAPE_TYPE,
    nodeKeyFromShapeId,
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
            // Negative and fractional, as a real canvas has: an integer-only
            // path would hide a coercion on the way into the store.
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

async function mountHost(
    rows: GraphRows = ROWS,
    opts: { readOnly?: boolean; onDirty?: () => void } = {},
) {
    let editor: Editor | undefined;
    let container!: HTMLElement;
    await act(async () => {
        ({ container } = render(
            <div style={{ width: 800, height: 600 }}>
                <TldrawProcessCanvas
                    rows={rows}
                    readOnly={opts.readOnly}
                    onDirty={opts.onDirty}
                    onEditorReady={(e) => {
                        editor = e;
                    }}
                />
            </div>,
        ));
    });
    if (!editor) {
        throw new Error('onEditorReady never fired — the host did not finish mounting');
    }
    return { container, editor };
}

describe('the host loads rows into the store', () => {
    it('every node row becomes a shape, identified by its nodeKey', async () => {
        const { editor } = await mountHost();

        const shapes = editor
            .getCurrentPageShapes()
            .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE);

        // Count AND identity: a host that created one shape twice would satisfy
        // a bare count.
        expect(shapes).toHaveLength(ROWS.nodes.length);
        expect(
            shapes.map((s) => nodeKeyFromShapeId(String(s.id))).sort(),
        ).toEqual(['n1', 'n2']);
    });

    it('carries position through unchanged, fractions and negatives included', async () => {
        const { editor } = await mountHost();
        const shapes = editor.getCurrentPageShapes();
        const n2 = shapes.find((s) => nodeKeyFromShapeId(String(s.id)) === 'n2');
        expect(n2).toBeDefined();
        expect({ x: n2?.x, y: n2?.y }).toEqual({ x: -412.5, y: 96.25 });
    });

    it('every edge row becomes a binding between the right two shapes', async () => {
        const { editor } = await mountHost();

        const bindings = editor
            .getBindingsInvolvingShape(
                editor
                    .getCurrentPageShapes()
                    .find((s) => nodeKeyFromShapeId(String(s.id)) === 'n1')!.id,
            )
            .filter((b) => b.type === PROCESS_EDGE_BINDING_TYPE);

        expect(bindings).toHaveLength(1);
        // Direction is load-bearing — a → b and b → a are different edges and
        // both are legal, so an endpoint swap must not pass.
        expect(nodeKeyFromShapeId(String(bindings[0]!.fromId))).toBe('n1');
        expect(nodeKeyFromShapeId(String(bindings[0]!.toId))).toBe('n2');
    });

    it('a graph with no edges creates no bindings and still loads its nodes', async () => {
        // The host guards `createBindings` behind a length check; without this
        // the empty case is untested and an empty-array call could throw.
        const { editor } = await mountHost({ nodes: ROWS.nodes, edges: [] });
        expect(
            editor
                .getCurrentPageShapes()
                .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE),
        ).toHaveLength(2);
    });
});

describe('readOnly is a prop now, not the only mode', () => {
    it('defaults to EDITABLE — this is the canvas', async () => {
        // The previous slice hard-coded read-only because it had no write path
        // to offer. Now that it reports edits, refusing them by default would
        // be the wrong way round.
        const { editor } = await mountHost();
        expect(editor.getInstanceState().isReadonly).toBe(false);
    });

    it('locks the store when asked, WITH the shapes already loaded', async () => {
        // The conjunction is the assertion. Read-only set before seeding would
        // give an empty, locked canvas and no error at all — so neither half
        // alone would catch the ordering being wrong.
        const { editor } = await mountHost(ROWS, { readOnly: true });
        expect(editor.getInstanceState().isReadonly).toBe(true);
        expect(
            editor
                .getCurrentPageShapes()
                .filter((s) => s.type === PROCESS_NODE_SHAPE_TYPE),
        ).toHaveLength(ROWS.nodes.length);
    });
});

describe('dirty reporting', () => {
    it('loading a map does NOT mark it dirty', async () => {
        // THE ordering claim. `createShapes` is a local change, so a listener
        // registered before the seed sees it as `source: 'user'` like any other
        // — the filter does not exempt it. Register first and every page load
        // marks the document dirty, autosaves, and bumps `version` for a map
        // nobody touched.
        const onDirty = jest.fn();
        await mountHost(ROWS, { onDirty });
        expect(onDirty).not.toHaveBeenCalled();
    });

    it('but a real edit after the load does', async () => {
        // Teeth for the test above: "never fires" is also true of a listener
        // that was never registered.
        const onDirty = jest.fn();
        const { editor } = await mountHost(ROWS, { onDirty });

        await act(async () => {
            editor.updateShape({
                id: editor.getCurrentPageShapes()[0]!.id,
                type: PROCESS_NODE_SHAPE_TYPE,
                props: { label: 'Edited' },
            });
        });

        expect(onDirty).toHaveBeenCalled();
    });

    it('a camera change does not mark the document dirty', async () => {
        // MEASURED, and not by the mechanism the first draft of this comment
        // named. It said the `scope: 'document'` filter drops camera records
        // before the mapper sees them — true, but not what makes this pass:
        // changing the filter to `'all'` reddens nothing, because a camera
        // record's `typeName` is one the mapper does not recognise and it
        // classifies as `unknown` → transient anyway.
        //
        // So the mapper is the guarantee and the filter is an optimisation.
        // The property asserted here — panning does not autosave — is real
        // either way, which is why the test stays.
        const onDirty = jest.fn();
        const { editor } = await mountHost(ROWS, { onDirty });

        await act(async () => {
            editor.setCamera({ x: 120, y: -40, z: 2 });
        });

        expect(onDirty).not.toHaveBeenCalled();
    });

    it('a selection change does not either', async () => {
        const onDirty = jest.fn();
        const { editor } = await mountHost(ROWS, { onDirty });

        await act(async () => {
            editor.select(editor.getCurrentPageShapes()[0]!.id);
        });

        expect(onDirty).not.toHaveBeenCalled();
    });
});

describe('history belongs to the editor', () => {
    it('an edit is undoable through tldraw, with no app history fed', async () => {
        // `use-canvas-history` is deliberately not wired: feeding both would
        // double-handle undo, one entry from the editor and one from the app
        // for a single edit. The document bar's canUndo / canRedo / undo / redo
        // map onto these four methods when it is wired.
        const { editor } = await mountHost();
        const id = editor.getCurrentPageShapes()[0]!.id;

        // Seeding happens inside a mount; what matters is that a USER edit is
        // undoable, so the baseline is taken after it.
        await act(async () => {
            editor.updateShape({
                id,
                type: PROCESS_NODE_SHAPE_TYPE,
                props: { label: 'Edited' },
            });
        });
        expect(editor.getCanUndo()).toBe(true);

        await act(async () => {
            editor.undo();
        });
        const after = editor.getShape(id);
        expect((after?.props as { label?: string } | undefined)?.label).not.toBe('Edited');
        expect(editor.getCanRedo()).toBe(true);
    });
});
