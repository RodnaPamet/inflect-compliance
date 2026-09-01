/**
 * Tree Helpers — Functional Unit Tests
 *
 * Behavioural coverage for the pure `<TreeView>` helpers in
 * `src/lib/framework-tree/tree-helpers.ts`. This module is
 * behaviour-heavy (a tree-flatten transform, a keyboard-nav state
 * machine, a structural filter, and immutable set toggles) yet
 * shipped without a single functional test.
 *
 * Every assertion here exercises a real input→output / branch /
 * edge-case path. No structural string scans.
 */

import {
    flattenVisible,
    collectExpandableIds,
    resolveTreeKey,
    getExpandToggleState,
    filterTree,
    toggleExpanded,
    withExpanded,
    type FlatRow,
} from '../../src/lib/framework-tree/tree-helpers';
import type { TreeViewNode } from '../../src/lib/framework-tree/types';

// ─── Fixtures ──────────────────────────────────────────────────────────

interface Node extends TreeViewNode {
    id: string;
    label: string;
    children: readonly Node[];
}

const leaf = (id: string, label = id): Node => ({ id, label, children: [] });

/**
 *   a
 *   ├─ a1
 *   │  ├─ a1x
 *   │  └─ a1y
 *   └─ a2
 *   b   (leaf)
 */
function sampleTree(): Node[] {
    return [
        {
            id: 'a',
            label: 'alpha',
            children: [
                {
                    id: 'a1',
                    label: 'alpha-one',
                    children: [leaf('a1x'), leaf('a1y')],
                },
                leaf('a2', 'alpha-two'),
            ],
        },
        leaf('b', 'bravo'),
    ];
}

// ═════════════════════════════════════════════════════════════════════
// 1. flattenVisible — visible-flat materialisation
// ═════════════════════════════════════════════════════════════════════

describe('flattenVisible', () => {
    test('collapsed tree yields only top-level rows', () => {
        const rows = flattenVisible(sampleTree(), new Set());
        expect(rows.map((r) => r.node.id)).toEqual(['a', 'b']);
        expect(rows.every((r) => r.depth === 0)).toBe(true);
    });

    test('expanding a parent reveals its direct children', () => {
        const rows = flattenVisible(sampleTree(), new Set(['a']));
        expect(rows.map((r) => r.node.id)).toEqual(['a', 'a1', 'a2', 'b']);
    });

    test('children stay hidden when an ancestor is collapsed', () => {
        // a1 is "expanded" but its parent a is NOT — a1's children
        // must not surface because a1 itself is not visible-expanded.
        const rows = flattenVisible(sampleTree(), new Set(['a1']));
        expect(rows.map((r) => r.node.id)).toEqual(['a', 'b']);
    });

    test('nested expansion produces correct depth + parentIds', () => {
        const rows = flattenVisible(sampleTree(), new Set(['a', 'a1']));
        const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
        expect(rows.map((r) => r.node.id)).toEqual([
            'a', 'a1', 'a1x', 'a1y', 'a2', 'b',
        ]);
        expect(byId['a'].depth).toBe(0);
        expect(byId['a1'].depth).toBe(1);
        expect(byId['a1x'].depth).toBe(2);
        expect(byId['a1x'].parentIds).toEqual(['a', 'a1']);
        expect(byId['a2'].parentIds).toEqual(['a']);
        expect(byId['b'].parentIds).toEqual([]);
    });

    test('index is a stable 0-based position in the visible-flat list', () => {
        const rows = flattenVisible(sampleTree(), new Set(['a', 'a1']));
        rows.forEach((r, i) => expect(r.index).toBe(i));
    });

    test('expanded flag mirrors set membership per row', () => {
        const rows = flattenVisible(sampleTree(), new Set(['a']));
        const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
        expect(byId['a'].expanded).toBe(true);
        expect(byId['b'].expanded).toBe(false);
    });

    test('empty input yields empty output', () => {
        expect(flattenVisible([], new Set())).toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. collectExpandableIds — whole-tree id collection
// ═════════════════════════════════════════════════════════════════════

describe('collectExpandableIds', () => {
    test('returns only ids of nodes that have children', () => {
        const ids = collectExpandableIds(sampleTree());
        expect([...ids].sort()).toEqual(['a', 'a1']);
    });

    test('leaf-only forest yields an empty set', () => {
        const ids = collectExpandableIds([leaf('x'), leaf('y')]);
        expect(ids.size).toBe(0);
    });

    test('passing the result to flattenVisible expands the whole tree', () => {
        const tree = sampleTree();
        const rows = flattenVisible(tree, collectExpandableIds(tree));
        expect(rows).toHaveLength(6); // every node visible
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. resolveTreeKey — keyboard-nav state machine
// ═════════════════════════════════════════════════════════════════════

describe('resolveTreeKey', () => {
    const expandedAll = new Set(['a', 'a1']);
    const rowsAll = (): FlatRow<Node>[] =>
        flattenVisible(sampleTree(), expandedAll);

    test('returns null when there are no rows', () => {
        expect(resolveTreeKey('ArrowDown', 'a', [], new Set())).toBeNull();
    });

    test('returns null when focusedId is not in the row list', () => {
        expect(
            resolveTreeKey('ArrowDown', 'ghost', rowsAll(), expandedAll),
        ).toBeNull();
    });

    test('ArrowDown moves focus to the next visible row', () => {
        expect(resolveTreeKey('ArrowDown', 'a', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'a1',
        });
    });

    test('ArrowDown on the last row is a no-op', () => {
        expect(resolveTreeKey('ArrowDown', 'b', rowsAll(), expandedAll)).toBeNull();
    });

    test('ArrowUp moves focus to the previous visible row', () => {
        expect(resolveTreeKey('ArrowUp', 'a1', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'a',
        });
    });

    test('ArrowUp on the first row is a no-op', () => {
        expect(resolveTreeKey('ArrowUp', 'a', rowsAll(), expandedAll)).toBeNull();
    });

    test('Home jumps to the first visible row', () => {
        expect(resolveTreeKey('Home', 'b', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'a',
        });
    });

    test('End jumps to the last visible row', () => {
        expect(resolveTreeKey('End', 'a', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'b',
        });
    });

    test('ArrowRight on a collapsed parent emits an expand effect', () => {
        const rows = flattenVisible(sampleTree(), new Set());
        expect(resolveTreeKey('ArrowRight', 'a', rows, new Set())).toEqual({
            type: 'expand',
            id: 'a',
        });
    });

    test('ArrowRight on an already-expanded parent descends to first child', () => {
        expect(resolveTreeKey('ArrowRight', 'a', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'a1',
        });
    });

    test('ArrowRight on a leaf is a no-op', () => {
        expect(resolveTreeKey('ArrowRight', 'b', rowsAll(), expandedAll)).toBeNull();
    });

    test('ArrowLeft on an expanded parent emits a collapse effect', () => {
        expect(resolveTreeKey('ArrowLeft', 'a', rowsAll(), expandedAll)).toEqual({
            type: 'collapse',
            id: 'a',
        });
    });

    test('ArrowLeft on a child row moves focus to its parent', () => {
        expect(resolveTreeKey('ArrowLeft', 'a1x', rowsAll(), expandedAll)).toEqual({
            type: 'focus',
            id: 'a1',
        });
    });

    test('ArrowLeft on a collapsed top-level parent is a no-op', () => {
        const rows = flattenVisible(sampleTree(), new Set());
        expect(resolveTreeKey('ArrowLeft', 'a', rows, new Set())).toBeNull();
    });

    test('an unrecognised key returns null', () => {
        expect(resolveTreeKey('Tab', 'a', rowsAll(), expandedAll)).toBeNull();
    });

    test('hasChildren flag is honoured even with no children array', () => {
        const rows: FlatRow<TreeViewNode>[] = [
            { node: { id: 'lazy', hasChildren: true }, depth: 0, expanded: false, index: 0, parentIds: [] },
        ];
        expect(resolveTreeKey('ArrowRight', 'lazy', rows, new Set())).toEqual({
            type: 'expand',
            id: 'lazy',
        });
    });

    test('ArrowRight on an expanded lazy node (hasChildren but no children array) is a no-op', () => {
        // hasChildren=true so it is "expandable"; expanded set has it
        // so we try to descend — but there is no children array to
        // descend into. Exercises the `firstChild` undefined branch.
        const rows: FlatRow<TreeViewNode>[] = [
            { node: { id: 'lazy', hasChildren: true }, depth: 0, expanded: true, index: 0, parentIds: [] },
        ];
        expect(resolveTreeKey('ArrowRight', 'lazy', rows, new Set(['lazy']))).toBeNull();
    });

    test('ArrowLeft falls back to the children-length check when hasChildren is absent', () => {
        // No `hasChildren` flag — the helper derives expandability
        // from `children?.length`. An expanded such node collapses.
        const expanded = new Set(['a']);
        const rows = flattenVisible(sampleTree(), expanded);
        // sampleTree nodes carry no `hasChildren` flag — only children.
        expect(resolveTreeKey('ArrowLeft', 'a', rows, expanded)).toEqual({
            type: 'collapse',
            id: 'a',
        });
    });

    test('ArrowRight on a node with an empty children array is a no-op', () => {
        // children: [] and no hasChildren flag → `(0) > 0` is false.
        const rows: FlatRow<TreeViewNode>[] = [
            { node: { id: 'empty', children: [] }, depth: 0, expanded: false, index: 0, parentIds: [] },
        ];
        expect(resolveTreeKey('ArrowRight', 'empty', rows, new Set())).toBeNull();
    });

    // ── ArrowLeft on an EXPLICIT hasChildren flag ──────────────────
    //
    // ArrowRight already had a lazy-node case; ArrowLeft did not, so the
    // left-hand side of its `row.node.hasChildren ?? (children…)` was
    // never taken. That matters for lazy trees: a node whose children
    // have not been fetched has `children: undefined`, so the fallback
    // computes `0 > 0` → false and ArrowLeft would jump to the PARENT
    // instead of collapsing the node the user is standing on.
    test('ArrowLeft collapses an expanded lazy node via its hasChildren flag', () => {
        const rows: FlatRow<TreeViewNode>[] = [
            { node: { id: 'root', hasChildren: true }, depth: 0, expanded: true, index: 0, parentIds: [] },
            { node: { id: 'lazy', hasChildren: true }, depth: 1, expanded: true, index: 1, parentIds: ['root'] },
        ];
        expect(resolveTreeKey('ArrowLeft', 'lazy', rows, new Set(['root', 'lazy']))).toEqual({
            type: 'collapse',
            id: 'lazy',
        });
    });

    test('ArrowLeft on a COLLAPSED lazy node walks to the parent rather than collapsing again', () => {
        const rows: FlatRow<TreeViewNode>[] = [
            { node: { id: 'root', hasChildren: true }, depth: 0, expanded: true, index: 0, parentIds: [] },
            { node: { id: 'lazy', hasChildren: true }, depth: 1, expanded: false, index: 1, parentIds: ['root'] },
        ];
        expect(resolveTreeKey('ArrowLeft', 'lazy', rows, new Set(['root']))).toEqual({
            type: 'focus',
            id: 'root',
        });
    });

    // `hasChildren: false` is an EXPLICIT false, not an absence — `??`
    // must not fall through to the children-length check.
    test('an explicit hasChildren=false wins over a non-empty children array', () => {
        const rows: FlatRow<TreeViewNode>[] = [
            {
                node: { id: 'sealed', hasChildren: false, children: [{ id: 'hidden' }] },
                depth: 0,
                expanded: true,
                index: 0,
                parentIds: [],
            },
        ];
        expect(resolveTreeKey('ArrowLeft', 'sealed', rows, new Set(['sealed']))).toBeNull();
        expect(resolveTreeKey('ArrowRight', 'sealed', rows, new Set())).toBeNull();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. getExpandToggleState — tri/quad-state derivation
// ═════════════════════════════════════════════════════════════════════

describe('getExpandToggleState', () => {
    test('"empty" when nothing is expandable', () => {
        expect(getExpandToggleState(0, 0)).toBe('empty');
    });

    test('"none" when nothing is expanded but the tree has branches', () => {
        expect(getExpandToggleState(0, 5)).toBe('none');
    });

    test('"all" when every expandable node is expanded', () => {
        expect(getExpandToggleState(5, 5)).toBe('all');
    });

    test('"all" when expanded count exceeds total (stale-set safety)', () => {
        expect(getExpandToggleState(7, 5)).toBe('all');
    });

    test('"partial" for an in-between count', () => {
        expect(getExpandToggleState(2, 5)).toBe('partial');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. filterTree — structural subtree filter
// ═════════════════════════════════════════════════════════════════════

describe('filterTree', () => {
    test('a self-match on a top-level node keeps its whole subtree intact', () => {
        const out = filterTree(sampleTree(), (n) => n.id === 'a');
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('a');
        expect(out[0].children.map((c) => c.id)).toEqual(['a1', 'a2']);
        expect(out[0].children[0].children.map((c) => c.id)).toEqual(['a1x', 'a1y']);
    });

    test('a self-match on a NESTED node surfaces it under its ancestors, subtree intact', () => {
        // 'a1' self-matches: it surfaces under its (non-matching)
        // ancestor 'a', and its OWN children survive untouched —
        // a self-match short-circuits the recursive prune.
        const out = filterTree(sampleTree(), (n) => n.id === 'a1');
        expect(out.map((n) => n.id)).toEqual(['a']);
        expect(out[0].children.map((c) => c.id)).toEqual(['a1']);
        expect(out[0].children[0].children.map((c) => c.id)).toEqual(['a1x', 'a1y']);
    });

    test('a descendant match keeps ancestors but prunes sibling branches', () => {
        const out = filterTree(sampleTree(), (n) => n.id === 'a1x');
        // 'a' kept as ancestor; 'a2' (no match underneath) pruned;
        // 'b' (no match) pruned.
        expect(out.map((n) => n.id)).toEqual(['a']);
        expect(out[0].children.map((c) => c.id)).toEqual(['a1']);
        expect(out[0].children[0].children.map((c) => c.id)).toEqual(['a1x']);
    });

    test('no match anywhere yields an empty forest', () => {
        expect(filterTree(sampleTree(), () => false)).toEqual([]);
    });

    test('match-all returns every top-level branch', () => {
        const out = filterTree(sampleTree(), () => true);
        expect(out.map((n) => n.id)).toEqual(['a', 'b']);
    });

    test('a self-match preserves the original node reference', () => {
        const tree = sampleTree();
        const out = filterTree(tree, (n) => n.id === 'a');
        // Self-match pushes the node as-is — no clone.
        expect(out[0]).toBe(tree[0]);
    });

    test('a synthesized ancestor is a fresh object, not the original', () => {
        const tree = sampleTree();
        const out = filterTree(tree, (n) => n.id === 'a1x');
        expect(out[0]).not.toBe(tree[0]); // 'a' was rebuilt
    });
});

// ═════════════════════════════════════════════════════════════════════
// 6. toggleExpanded / withExpanded — immutable set operations
// ═════════════════════════════════════════════════════════════════════

describe('toggleExpanded', () => {
    test('adds an id that was absent', () => {
        const next = toggleExpanded(new Set(['a']), 'b');
        expect([...next].sort()).toEqual(['a', 'b']);
    });

    test('removes an id that was present', () => {
        const next = toggleExpanded(new Set(['a', 'b']), 'b');
        expect([...next]).toEqual(['a']);
    });

    test('always returns a new set (never mutates the input)', () => {
        const prev = new Set(['a']);
        const next = toggleExpanded(prev, 'b');
        expect(next).not.toBe(prev);
        expect([...prev]).toEqual(['a']); // input untouched
    });
});

describe('withExpanded', () => {
    test('on=true adds a missing id', () => {
        const next = withExpanded(new Set(['a']), 'b', true);
        expect(next.has('b')).toBe(true);
    });

    test('on=false removes a present id', () => {
        const next = withExpanded(new Set(['a', 'b']), 'b', false);
        expect(next.has('b')).toBe(false);
    });

    test('returns the SAME reference when the requested state is a no-op', () => {
        // Referential-equality bailout: adding an id already present,
        // or removing one already absent, must return prev unchanged.
        const prev = new Set(['a']);
        expect(withExpanded(prev, 'a', true)).toBe(prev);
        expect(withExpanded(prev, 'z', false)).toBe(prev);
    });

    test('returns a new reference when the state actually changes', () => {
        const prev = new Set(['a']);
        expect(withExpanded(prev, 'b', true)).not.toBe(prev);
    });
});
