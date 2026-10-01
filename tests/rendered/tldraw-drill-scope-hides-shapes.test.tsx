/**
 * @jest-environment jsdom
 *
 * Drilling into a group actually hides what is out of scope.
 *
 * ── Why this asserts isShapeHidden and not the predicate ────────────
 *
 * `drill-scope-host` is unit-tested by calling `shapeVisibilityForScope`
 * directly, and that suite passes against a design that does not work.
 *
 * `getShapeVisibility` is consulted through `Editor.getIsShapeHiddenCache`,
 * which is a `@computed` from tldraw's signals library: it re-evaluates only
 * when a SIGNAL read during its last evaluation changes. My first design held
 * the scope in a React ref — not a signal — so the predicate would have
 * returned the right answer and the cache would never have re-asked. Scope
 * correct in code, stale on screen, with every direct-call test green.
 *
 * So the assertions here go through `editor.isShapeHidden`, which is the thing
 * that consults the cache. Holding the scope in an `atom` is what makes them
 * pass; a ref makes them fail.
 *
 * (The same first draft also called `editor.markShapesDirty?.()` to force a
 * repaint. That method does not exist, and the optional call made its absence
 * silent — a line that looked like the fix and did nothing.)
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import { shapeIdForEdgeKey } from '@/components/processes/tldraw/process-edge-shape';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (k: string, type: string, parent: string | null, x: number) => ({
    nodeKey: k, nodeType: type, label: `label-${k}`, subtitle: null,
    posX: x, posY: 0, parentNodeKey: parent, dataJson: null,
});

/** A group with two children, a node outside it, and an annotation. */
const ROWS: GraphRows = {
    nodes: [
        node('grp', 'group', null, 0),
        node('in1', 'processStep', 'grp', 100),
        node('in2', 'processStep', 'grp', 200),
        node('out', 'processStep', null, 400),
    ],
    edges: [
        { edgeKey: 'inside', sourceKey: 'in1', targetKey: 'in2', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
        { edgeKey: 'crossing', sourceKey: 'in2', targetKey: 'out', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
    ],
};

const entered: string[] = [];

async function mount(drillGroupId: string | null = null) {
    entered.length = 0;
    let editor: Editor | undefined;
    const view = render(
        <div style={{ width: 900, height: 600 }}>
            <TldrawProcessCanvas
                rows={ROWS}
                drillGroupId={drillGroupId}
                onEnterGroup={(k) => entered.push(k)}
                onEditorReady={(e) => (editor = e)}
            />
        </div>,
    );
    await act(async () => {});
    if (!editor) throw new Error('the host did not finish mounting');
    const rerenderWith = async (next: string | null) => {
        view.rerender(
            <div style={{ width: 900, height: 600 }}>
                <TldrawProcessCanvas
                    rows={ROWS}
                    drillGroupId={next}
                    onEnterGroup={(k) => entered.push(k)}
                    onEditorReady={(e) => (editor = e)}
                />
            </div>,
        );
        await act(async () => {});
    };
    return { editor, rerenderWith };
}

const hiddenNode = (e: Editor, k: string) => e.isShapeHidden(shapeIdForNodeKey(k) as never);
const hiddenLine = (e: Editor, k: string) => e.isShapeHidden(shapeIdForEdgeKey(k) as never);

describe('at root nothing is hidden', () => {
    it('every node and line is visible', async () => {
        const { editor } = await mount(null);
        for (const k of ['grp', 'in1', 'in2', 'out']) {
            expect(hiddenNode(editor, k)).toBe(false);
        }
        expect(hiddenLine(editor, 'inside')).toBe(false);
        expect(hiddenLine(editor, 'crossing')).toBe(false);
    });
});

describe('drilling into a group hides what is outside it', () => {
    it('the group\'s children stay, the rest goes', async () => {
        const { editor } = await mount('grp');
        expect(hiddenNode(editor, 'in1')).toBe(false);
        expect(hiddenNode(editor, 'in2')).toBe(false);
        // The group itself and the outside node are out of scope.
        expect(hiddenNode(editor, 'out')).toBe(true);
        expect(hiddenNode(editor, 'grp')).toBe(true);
    });

    it('a line survives only if BOTH endpoints are in scope', async () => {
        const { editor } = await mount('grp');
        expect(hiddenLine(editor, 'inside')).toBe(false);
        // in2 -> out crosses the boundary; a line to a hidden node is a line
        // into empty space.
        expect(hiddenLine(editor, 'crossing')).toBe(true);
    });

    it('and the change takes effect when the level CHANGES — the atom test', async () => {
        /**
         * THE assertion this file exists for.
         *
         * Mounting already-drilled would pass with the scope in a ref, because
         * the cache evaluates once with the right value. Changing the level
         * after mount is what requires the cache to be INVALIDATED, and only a
         * signal does that.
         */
        const { editor, rerenderWith } = await mount(null);
        expect(hiddenNode(editor, 'out')).toBe(false);

        await rerenderWith('grp');
        expect(hiddenNode(editor, 'out')).toBe(true);

        // And back out again — the scope is a view, so it is reversible.
        await rerenderWith(null);
        expect(hiddenNode(editor, 'out')).toBe(false);
    });
});

describe('a hidden shape still SAVES', () => {
    it('drilling in and serialising keeps the whole map', async () => {
        /**
         * The data-loss case. tldraw's store IS the document, so if the
         * serializer read the view rather than the store, drilling into a group
         * and letting autosave fire would delete every node outside it.
         *
         * Verified empirically before this was wired, and asserted here now
         * that it can regress: `getCurrentPageShapes` does not filter hidden
         * shapes, so the scope cannot touch what is persisted.
         */
        const { editor } = await mount('grp');
        expect(hiddenNode(editor, 'out')).toBe(true);

        const { rows } = serializeEditorCanvas(editor);
        expect(rows.nodes.map((n) => n.nodeKey).sort()).toEqual(
            ['grp', 'in1', 'in2', 'out'],
        );
        expect(rows.edges.map((e) => e.edgeKey).sort()).toEqual(['crossing', 'inside']);
    });
});

describe('the enter gesture', () => {
    it('double-clicking a GROUP asks to go inside it', async () => {
        const { editor } = await mount(null);
        await act(async () => {
            // Put the pointer over the group, then emit the event tldraw emits.
            editor.inputs.currentPagePoint.x = 10;
            editor.inputs.currentPagePoint.y = 10;
            editor.emit('event', {
                type: 'click', name: 'double_click', phase: 'up',
                button: 0, point: { x: 10, y: 10 }, pointerId: 0,
            } as never);
        });
        expect(entered).toEqual(['grp']);
    });

    it('double-clicking a STEP does not — that is label editing', async () => {
        // Stealing double-click on a step would break renaming, which is the
        // gesture tldraw assigns to it.
        const { editor } = await mount(null);
        await act(async () => {
            editor.inputs.currentPagePoint.x = 110;
            editor.inputs.currentPagePoint.y = 10;
            editor.emit('event', {
                type: 'click', name: 'double_click', phase: 'up',
                button: 0, point: { x: 110, y: 10 }, pointerId: 0,
            } as never);
        });
        expect(entered).toEqual([]);
    });

    it('ignores the down phase, so one gesture fires once', async () => {
        const { editor } = await mount(null);
        await act(async () => {
            editor.inputs.currentPagePoint.x = 10;
            editor.inputs.currentPagePoint.y = 10;
            for (const phase of ['down', 'settle']) {
                editor.emit('event', {
                    type: 'click', name: 'double_click', phase,
                    button: 0, point: { x: 10, y: 10 }, pointerId: 0,
                } as never);
            }
        });
        expect(entered).toEqual([]);
    });
});
