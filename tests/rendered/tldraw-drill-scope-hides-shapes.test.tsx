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

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import { serializeEditorCanvas } from '@/components/processes/tldraw/editor-canvas';
import { shapeIdForEdgeKey } from '@/components/processes/tldraw/process-edge-shape';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (
    k: string, type: string, parent: string | null, x: number,
    // #3117 — a fold lives at `dataJson.collapsed`, so a fixture needs to set it.
    dataJson: unknown = null,
) => ({
    nodeKey: k, nodeType: type, label: `label-${k}`, subtitle: null,
    posX: x, posY: 0, parentNodeKey: parent, dataJson,
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

async function mount(drillGroupId: string | null = null, rows: GraphRows = ROWS) {
    entered.length = 0;
    let editor: Editor | undefined;
    const view = render(
        <div style={{ width: 900, height: 600 }}>
            <TldrawProcessCanvas
                rows={rows}
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

/**
 * Collapsible groups (#3117) — folding, and the persistence xyflow never had.
 *
 * These go through `editor.isShapeHidden` for the reason this file's header
 * gives: the predicate is consulted via `getIsShapeHiddenCache`, which is
 * `@computed` and invalidates only on SIGNALS read during evaluation. A fold
 * driven off a plain ref would be correct in code and stale on screen, with
 * every direct-call test green — so only the real cache proves the wiring.
 */
describe('folding a group hides what is inside it', () => {
    /** Fold `grp` the way the chevron does: merge into `dataJson`. */
    const fold = async (editor: Editor, key: string, collapsed: boolean) => {
        const id = shapeIdForNodeKey(key) as never;
        const prev = (editor.getShape(id) as unknown as { props: { dataJson: unknown } }).props
            .dataJson as Record<string, unknown> | null;
        await act(async () => {
            editor.updateShape({
                id,
                type: 'process-node',
                props: { dataJson: { ...(prev ?? {}), collapsed } },
            } as never);
        });
    };

    it('hides the children through the REAL hidden-shape cache', async () => {
        const { editor } = await mount();
        expect(hiddenNode(editor, 'in1')).toBe(false);

        await fold(editor, 'grp', true);

        expect(hiddenNode(editor, 'in1')).toBe(true);
        expect(hiddenNode(editor, 'in2')).toBe(true);
        // The group stays — it is what you click to unfold.
        expect(hiddenNode(editor, 'grp')).toBe(false);
        // And a fold says nothing about the rest of the map.
        expect(hiddenNode(editor, 'out')).toBe(false);
    });

    it('and the lines into them go too', async () => {
        const { editor } = await mount();
        await fold(editor, 'grp', true);
        expect(hiddenLine(editor, 'inside')).toBe(true);
        expect(hiddenLine(editor, 'crossing')).toBe(true);
    });

    it('unfolding brings them back — the toggle goes both ways', async () => {
        const { editor } = await mount();
        await fold(editor, 'grp', true);
        expect(hiddenNode(editor, 'in1')).toBe(true);
        await fold(editor, 'grp', false);
        expect(hiddenNode(editor, 'in1')).toBe(false);
        expect(hiddenLine(editor, 'inside')).toBe(false);
    });

    it('a folded group still SAVES EVERYTHING — the data-loss case', async () => {
        /*
            The same hazard the drill scope has: tldraw's store IS the document,
            so a fold expressed by deleting shapes would delete the user's nodes
            the next time autosave fired. Folding is a VIEW over the store, and
            `getCurrentPageShapes` does not filter hidden shapes.
        */
        const { editor } = await mount();
        await fold(editor, 'grp', true);
        expect(hiddenNode(editor, 'in1')).toBe(true);

        const { rows } = serializeEditorCanvas(editor);
        expect(rows.nodes.map((n) => n.nodeKey).sort()).toEqual(['grp', 'in1', 'in2', 'out']);
        expect(rows.edges.map((e) => e.edgeKey).sort()).toEqual(['crossing', 'inside']);
    });

    it('and the FOLD ITSELF persists — the half xyflow never had', async () => {
        /*
            The capability this issue is really about. On xyflow `collapsed` was
            dropped by the save serialiser deliberately, so a fold survived until
            the next reload and no further. It rides in `dataJson`, which the
            tldraw serialiser round-trips in both directions.
        */
        const { editor } = await mount();
        await fold(editor, 'grp', true);

        const { rows } = serializeEditorCanvas(editor);
        const grp = rows.nodes.find((n) => n.nodeKey === 'grp')!;
        expect((grp.dataJson as { collapsed?: unknown }).collapsed).toBe(true);
        // And nothing else grew a fold.
        for (const k of ['in1', 'in2', 'out']) {
            const n = rows.nodes.find((x) => x.nodeKey === k)!;
            expect((n.dataJson as { collapsed?: unknown } | null)?.collapsed).toBeUndefined();
        }
    });

    it('keeps the SIBLING keys in dataJson, rather than replacing the payload', async () => {
        // `dataJson` already carries `size`, `linkedEntityId` and `ruleId`. A
        // whole-value write would silently drop them.
        const withSize: GraphRows = {
            ...ROWS,
            nodes: [
                node('grp', 'group', null, 0, { size: 'lg', linkedEntityId: 'ent-1' }),
                node('in1', 'processStep', 'grp', 100),
                node('in2', 'processStep', 'grp', 200),
                node('out', 'processStep', null, 400),
            ],
        };
        /*
            Folded through THE CHEVRON, not the helper. The helper merges by
            construction, so driving this through it tested the helper: a
            mutation making the button REPLACE `dataJson` left all 17 assertions
            green. The merge is the button's behaviour, so the button has to be
            what performs it.
        */
        const { editor } = await mount(null, withSize);
        await act(async () => {
            fireEvent.pointerDown(screen.getByTestId('group-fold-grp'));
            fireEvent.click(screen.getByTestId('group-fold-grp'));
        });

        const { rows } = serializeEditorCanvas(editor);
        const grp = rows.nodes.find((n) => n.nodeKey === 'grp')!.dataJson as Record<string, unknown>;
        expect(grp.collapsed).toBe(true);
        expect(grp.size).toBe('lg');
        expect(grp.linkedEntityId).toBe('ent-1');
    });

    it('THE CHEVRON does it — the affordance, not just the mechanism', async () => {
        /*
            Everything above drives the fold through `updateShape`, which proves
            the visibility wiring and nothing about how a user reaches it. The
            chevron is the only collapse affordance — double-click is already
            taken by drill-down — so if the button does not land, the feature
            does not exist however green the mechanism tests are.

            It is also the codebase's first interactive control inside a tldraw
            shape, and the failure mode is specific: without
            `stopEventPropagation` on pointer-down, tldraw claims the gesture as
            a shape drag and the click never arrives.
        */
        const { editor } = await mount();
        const button = await screen.findByTestId('group-fold-grp');
        // The editor IS present here, unlike the shape-render harness.
        expect(button).not.toBeDisabled();
        expect(button).toHaveAttribute('aria-expanded', 'true');

        await act(async () => {
            fireEvent.pointerDown(button);
            fireEvent.click(button);
        });

        expect(hiddenNode(editor, 'in1')).toBe(true);
        expect(screen.getByTestId('group-fold-grp')).toHaveAttribute('aria-expanded', 'false');
    });

    it('and only GROUPS carry one — a step has nothing to fold', async () => {
        await mount();
        expect(screen.getByTestId('group-fold-grp')).toBeInTheDocument();
        expect(screen.queryByTestId('group-fold-in1')).toBeNull();
        expect(screen.queryByTestId('group-fold-out')).toBeNull();
    });

    it('and a map LOADED folded comes up folded', async () => {
        // The other half of persistence: restore. Without this the fold saves
        // and is ignored on the way back in.
        const preFolded: GraphRows = {
            ...ROWS,
            nodes: [
                node('grp', 'group', null, 0, { collapsed: true }),
                node('in1', 'processStep', 'grp', 100),
                node('in2', 'processStep', 'grp', 200),
                node('out', 'processStep', null, 400),
            ],
        };
        const { editor } = await mount(null, preFolded);
        expect(hiddenNode(editor, 'in1')).toBe(true);
        expect(hiddenNode(editor, 'grp')).toBe(false);
        expect(hiddenNode(editor, 'out')).toBe(false);
    });
});
