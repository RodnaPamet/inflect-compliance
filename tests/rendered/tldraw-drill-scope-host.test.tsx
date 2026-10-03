/**
 * @jest-environment jsdom
 *
 * Sub-flow drill-down scope, computed from a real tldraw store.
 *
 * The FILTER is engine-free and tested on its own. What is only testable here
 * is the translation: finding the parent relationship on a tldraw shape, and
 * turning a scope into the per-shape answer `getShapeVisibility` wants.
 *
 * ── The trap this is mostly here for ────────────────────────────────
 *
 * EVERY tldraw shape has a `parentId` — its page, or a containing frame — and
 * it means something entirely unrelated to a process group. The parent the
 * filter needs lives in `props.parentNodeKey`. Reading tldraw's own field
 * instead would give every node the same parent (`page:…`), which scopes the
 * canvas by frame membership and looks almost right on a map with no frames.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

import { act, render } from '@testing-library/react';
import type { Editor } from 'tldraw';

import { TldrawProcessCanvas } from '@/components/processes/TldrawProcessCanvas';
import {
    collapsedHiddenKeys,
    isCollapsedFromDataJson,
    drillEdgesFrom,
    drillNodesFrom,
    drillTrail,
    edgeEndpointIndex,
    shapeVisibilityForScope,
    visibleNodeKeys,
} from '@/components/processes/tldraw/drill-scope-host';
import { shapeIdForEdgeKey } from '@/components/processes/tldraw/process-edge-shape';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';
import type { GraphRows } from '@/components/processes/tldraw/serializer';

const node = (
    nodeKey: string,
    nodeType: string,
    parentNodeKey: string | null,
    posX = 0,
    // #3117 — a fold lives at `dataJson.collapsed`, so the fixture needs to be
    // able to set it. Defaults to null, which is every node on every map today.
    dataJson: unknown = null,
) => ({
    nodeKey, nodeType, label: `label-${nodeKey}`, subtitle: null,
    posX, posY: 0, parentNodeKey, dataJson,
});

/** A group `grp` with two children, one node outside it, and an annotation. */
const ROWS: GraphRows = {
    nodes: [
        node('grp', 'group', null, 0),
        node('in1', 'processStep', 'grp', 100),
        node('in2', 'processStep', 'grp', 200),
        node('out', 'processStep', null, 400),
        node('note', 'annotation', null, 600),
    ],
    edges: [
        { edgeKey: 'inside', sourceKey: 'in1', targetKey: 'in2', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
        { edgeKey: 'crossing', sourceKey: 'in2', targetKey: 'out', edgeKind: 'flow',
          labelOverride: null, dataJson: null, controls: [] },
    ],
};

async function mount(rows: GraphRows = ROWS): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 900, height: 600 }}>
                <TldrawProcessCanvas rows={rows} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the host did not finish mounting');
    return editor;
}

describe('reading the parent relationship', () => {
    it('keys nodes by nodeKey, not by shape id', async () => {
        const editor = await mount();
        const ids = drillNodesFrom(editor).map((n) => n.id).sort();
        expect(ids).toEqual(['grp', 'in1', 'in2', 'note', 'out']);
        // Not a single `shape:` prefix — drill-down reads, so it stays in the
        // row's id space rather than tldraw's.
        expect(ids.some((i) => i.startsWith('shape:'))).toBe(false);
    });

    it('takes the parent from props.parentNodeKey', async () => {
        const editor = await mount();
        const byId = new Map(drillNodesFrom(editor).map((n) => [n.id, n]));
        expect(byId.get('in1')?.parentId).toBe('grp');
        expect(byId.get('in2')?.parentId).toBe('grp');
    });

    it('and leaves parentId ABSENT for a node with no group — the trap', async () => {
        // THE discriminating case. Every tldraw shape has its own `parentId`
        // (the page), so reading that field instead would give `out` and `grp`
        // a parent of `page:…` rather than nothing — and the filter would then
        // scope by page membership, which is almost indistinguishable from
        // working on a map with no groups.
        const editor = await mount();
        const byId = new Map(drillNodesFrom(editor).map((n) => [n.id, n]));
        expect(byId.get('out')?.parentId).toBeUndefined();
        expect(byId.get('grp')?.parentId).toBeUndefined();
    });

    it('reads edges by row key', async () => {
        const editor = await mount();
        const edges = drillEdgesFrom(editor);
        expect(edges).toHaveLength(2);
        expect(edges.some((e) => e.source === 'in1' && e.target === 'in2')).toBe(true);
    });
});

describe('the scope', () => {
    it('is null at root — no filtering, not "everything"', async () => {
        const editor = await mount();
        expect(visibleNodeKeys(editor, null)).toBeNull();
    });

    it('inside a group is that group\'s direct children', async () => {
        const editor = await mount();
        const keys = visibleNodeKeys(editor, 'grp');
        expect(keys).not.toBeNull();
        expect([...keys!].sort()).toEqual(['in1', 'in2']);
    });

    it('excludes the group itself, the outside node, and the annotation', async () => {
        const editor = await mount();
        const keys = visibleNodeKeys(editor, 'grp')!;
        expect(keys.has('grp')).toBe(false);
        expect(keys.has('out')).toBe(false);
        expect(keys.has('note')).toBe(false);
    });
});

describe('per-shape visibility', () => {
    it('at root everything inherits', async () => {
        const editor = await mount();
        const vis = shapeVisibilityForScope(null, edgeEndpointIndex(editor));
        expect(vis({ id: String(shapeIdForNodeKey('out')), type: 'process-node',
            props: { nodeKey: 'out' } })).toBe('inherit');
        expect(vis({ id: 'shape:sticky', type: 'note' })).toBe('inherit');
    });

    it('shows an in-scope node and hides one outside', async () => {
        const editor = await mount();
        const vis = shapeVisibilityForScope(visibleNodeKeys(editor, 'grp'), edgeEndpointIndex(editor));
        expect(vis({ id: String(shapeIdForNodeKey('in1')), type: 'process-node',
            props: { nodeKey: 'in1' } })).toBe('inherit');
        expect(vis({ id: String(shapeIdForNodeKey('out')), type: 'process-node',
            props: { nodeKey: 'out' } })).toBe('hidden');
    });

    it('shows an edge line only when BOTH endpoints are in scope', async () => {
        // A line to a hidden node is a line into empty space, which reads as a
        // rendering fault rather than a scope.
        const editor = await mount();
        const vis = shapeVisibilityForScope(visibleNodeKeys(editor, 'grp'), edgeEndpointIndex(editor));
        expect(vis({ id: String(shapeIdForEdgeKey('inside')), type: 'process-edge-line' }))
            .toBe('inherit');
        expect(vis({ id: String(shapeIdForEdgeKey('crossing')), type: 'process-edge-line' }))
            .toBe('hidden');
    });

    it('hides an edge line whose binding is gone', async () => {
        const editor = await mount();
        const vis = shapeVisibilityForScope(visibleNodeKeys(editor, 'grp'), edgeEndpointIndex(editor));
        expect(vis({ id: 'shape:edge-ghost', type: 'process-edge-line' })).toBe('hidden');
    });

    it('hides freeform annotation while drilled in', async () => {
        // Matches the other engine, where the filter returns only the group's
        // children and the annotation layer is simply not in the array.
        const editor = await mount();
        const vis = shapeVisibilityForScope(visibleNodeKeys(editor, 'grp'), edgeEndpointIndex(editor));
        expect(vis({ id: 'shape:sticky', type: 'note' })).toBe('hidden');
    });
});

describe('the breadcrumb trail', () => {
    it('labels each level from the live shapes', async () => {
        const editor = await mount();
        const trail = drillTrail(editor, ['grp'], 'All processes');
        expect(trail).toHaveLength(2);
        expect(trail[0]).toEqual({ id: null, label: 'All processes' });
        expect(trail[1]).toEqual({ id: 'grp', label: 'label-grp' });
    });

    it('is just the root at depth zero', async () => {
        const editor = await mount();
        expect(drillTrail(editor, [])).toHaveLength(1);
    });
});

/**
 * Collapsible groups (#3117) — the fold as a SECOND reason to hide.
 *
 * Collapse and drill-down both hide nodes, and expressing the first through the
 * second does not work: `visibleNodeKeys` returns null at root meaning "no
 * filtering", and a fold's main case IS at root. Returning a set there instead
 * would switch the predicate out of its null fast path — and that path is what
 * keeps stickies, frames and drawings on screen, because the non-process arm
 * hides them whenever a drill scope exists.
 *
 * So folding one group at root would have hidden every annotation on the map.
 * That is the assertion this suite exists for.
 */
describe('isCollapsedFromDataJson', () => {
    it('is true only for the boolean true', () => {
        expect(isCollapsedFromDataJson({ collapsed: true })).toBe(true);
    });

    it('and false for every lookalike a bad client could write', () => {
        // `"true"` is the one that matters: a string would fold a group that
        // this product never folded.
        for (const v of [
            null, undefined, 42, 'true', [], {}, { collapsed: 'true' },
            { collapsed: 1 }, { collapsed: false }, { collapsed: null },
        ]) {
            expect(isCollapsedFromDataJson(v)).toBe(false);
        }
    });

    it('ignores siblings, because the payload is a passthrough', () => {
        expect(isCollapsedFromDataJson({ size: 'lg', ruleId: 'r1', collapsed: true })).toBe(true);
    });
});

describe('collapsedHiddenKeys', () => {
    const FOLDED: GraphRows = {
        ...ROWS,
        nodes: [
            node('grp', 'group', null, 0, { collapsed: true }),
            node('in1', 'processStep', 'grp', 100),
            node('in2', 'processStep', 'grp', 200),
            node('out', 'processStep', null, 400),
            node('note', 'annotation', null, 600),
        ],
    };

    it('is EMPTY when nothing is folded — the universal case today', async () => {
        const editor = await mount();
        expect(collapsedHiddenKeys(editor).size).toBe(0);
    });

    it('hides a folded group\'s children', async () => {
        const editor = await mount(FOLDED);
        const hidden = collapsedHiddenKeys(editor);
        expect(hidden.has('in1')).toBe(true);
        expect(hidden.has('in2')).toBe(true);
    });

    it('but NOT the group itself — it is what you click to unfold', async () => {
        // Hiding it would make the fold irreversible on the canvas.
        const editor = await mount(FOLDED);
        expect(collapsedHiddenKeys(editor).has('grp')).toBe(false);
    });

    it('and nothing outside it', async () => {
        const editor = await mount(FOLDED);
        const hidden = collapsedHiddenKeys(editor);
        expect(hidden.has('out')).toBe(false);
        expect(hidden.has('note')).toBe(false);
    });

    it('reaches a grandchild — the fold is TRANSITIVE', async () => {
        // A node inside a group inside a folded group is folded away too.
        const editor = await mount({
            nodes: [
                node('outer', 'group', null, 0, { collapsed: true }),
                node('inner', 'group', 'outer', 100),
                node('deep', 'processStep', 'inner', 200),
            ],
            edges: [],
        });
        const hidden = collapsedHiddenKeys(editor);
        expect(hidden.has('inner')).toBe(true);
        expect(hidden.has('deep')).toBe(true);
        expect(hidden.has('outer')).toBe(false);
    });

    it('and a parentNodeKey CYCLE terminates rather than hanging the canvas', async () => {
        // `parentNodeKey` is a free string on the wire, so a client could write
        // a cycle. The walk is bounded by the node count; it stops without
        // claiming an ancestor it never reached.
        const editor = await mount({
            nodes: [
                node('a', 'group', 'b', 0),
                node('b', 'group', 'a', 100),
            ],
            edges: [],
        });
        expect(() => collapsedHiddenKeys(editor)).not.toThrow();
        expect(collapsedHiddenKeys(editor).size).toBe(0);
    });
});

describe('a fold composes with the drill scope without borrowing it', () => {
    const FOLDED: GraphRows = {
        ...ROWS,
        nodes: [
            node('grp', 'group', null, 0, { collapsed: true }),
            node('in1', 'processStep', 'grp', 100),
            node('in2', 'processStep', 'grp', 200),
            node('out', 'processStep', null, 400),
            node('note', 'annotation', null, 600),
        ],
    };
    const vis = (editor: Editor, scope: Set<string> | null, hidden: Set<string>) =>
        shapeVisibilityForScope(scope, edgeEndpointIndex(editor), hidden);
    const nodeShape = (key: string) => ({
        id: shapeIdForNodeKey(key) as string,
        type: 'process-node',
        props: { nodeKey: key },
    });

    it('AT ROOT a fold hides the children and leaves the annotation alone', async () => {
        /*
            THE assertion. At root the scope is null, so the fold is the only
            reason anything is hidden — and the annotation must survive, because
            folding one group says nothing about the map as a whole.
        */
        const editor = await mount(FOLDED);
        const v = vis(editor, null, collapsedHiddenKeys(editor));
        expect(v(nodeShape('in1'))).toBe('hidden');
        expect(v(nodeShape('grp'))).toBe('inherit');
        expect(v(nodeShape('out'))).toBe('inherit');
        // A sticky note is not a process node and not an edge line.
        expect(v({ id: 'shape:sticky-1', type: 'geo', props: {} })).toBe('inherit');
    });

    it('and at root with NOTHING folded everything inherits — the fast path', async () => {
        const editor = await mount();
        const v = vis(editor, null, new Set());
        expect(v(nodeShape('in1'))).toBe('inherit');
        expect(v({ id: 'shape:sticky-1', type: 'geo', props: {} })).toBe('inherit');
    });

    it('an edge into a folded node is hidden, like a line into empty space', async () => {
        const editor = await mount(FOLDED);
        const v = vis(editor, null, collapsedHiddenKeys(editor));
        // `inside` joins two folded children; `crossing` joins a folded child to
        // a visible node — both are lines to nowhere.
        expect(v({ id: shapeIdForEdgeKey('inside') as string })).toBe('hidden');
        expect(v({ id: shapeIdForEdgeKey('crossing') as string })).toBe('hidden');
    });

    it('DRILLED IN, both reasons apply and the annotation goes back to hidden', async () => {
        // Inside a group the annotation layer is out of scope, which is the
        // pre-existing drill behaviour and must not change.
        const editor = await mount(FOLDED);
        const v = vis(editor, visibleNodeKeys(editor, 'grp'), collapsedHiddenKeys(editor));
        expect(v({ id: 'shape:sticky-1', type: 'geo', props: {} })).toBe('hidden');
        // In scope for the drill, still folded away.
        expect(v(nodeShape('in1'))).toBe('hidden');
    });
});
