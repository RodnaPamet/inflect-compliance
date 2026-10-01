/**
 * The command palette's enablement rules.
 *
 * Labels and ordering are visible the moment anyone opens the palette. The
 * enablement rules are not, and they are where the defects live: a command
 * offered when it cannot work produces an action that silently does nothing,
 * and a command disabled when it could work is a feature nobody finds.
 *
 * They are also NOT uniform, and the thresholds are taken from the live xyflow
 * canvas rather than from taste — align needs two, distribute needs three,
 * ungroup needs one. A test that checked them all against the same number
 * would pass on a builder that had flattened the distinction.
 */
import {
    buildCanvasCommandGroups,
    type CanvasCommandActions,
    type CanvasCommandContext,
} from '@/lib/processes/canvas-command-groups';

/** Identity translator: assertions are about structure, not copy. */
const t = (k: string) => k;

const noop = () => {};
const actions = (): CanvasCommandActions => ({
    save: noop, undo: noop, redo: noop, duplicate: noop,
    newDocument: noop,
    arrange: noop, arrangeForce: noop,
    group: noop, ungroup: noop, align: noop, distribute: noop,
    deleteSelection: noop, toggleSnap: noop,
});

const ctx = (over: Partial<CanvasCommandContext> = {}): CanvasCommandContext => ({
    hasMap: true, busy: false, canUndo: true, canRedo: true,
    nodeCount: 5, selectionCount: 0, snapEnabled: true, ...over,
});

const build = (over?: Partial<CanvasCommandContext>) =>
    buildCanvasCommandGroups(t, ctx(over), actions());

/** Every command, flattened, keyed by id. */
const byId = (over?: Partial<CanvasCommandContext>) => {
    const m = new Map<string, { disabled?: boolean; label: string }>();
    for (const g of build(over)) for (const c of g.commands) m.set(c.id, c);
    return m;
};
const off = (id: string, over?: Partial<CanvasCommandContext>) =>
    byId(over).get(id)?.disabled === true;

describe('the shape of the palette', () => {
    it('has the four groups, each headed', () => {
        const groups = build();
        expect(groups.map((g) => g.heading)).toEqual([
            'groupDocument', 'groupLayout', 'groupSelection', 'groupModes',
        ]);
        expect(groups.every((g) => g.commands.length > 0)).toBe(true);
    });

    it('carries 23 commands with unique ids when the optional two are absent', () => {
        const ids = build().flatMap((g) => g.commands.map((c) => c.id));
        expect(ids).toHaveLength(23);
        expect(new Set(ids).size).toBe(23);
    });

    it('omits a command whose action the host did not supply', () => {
        // A command that opened nothing would read as broken rather than
        // unavailable, which is worse than its absence.
        expect(byId().has('new-automation')).toBe(false);
        expect(byId().has('new-from-template')).toBe(false);
    });

    it('and INCLUDES them when the host can do them — teeth', () => {
        // Without this, a builder that had hardcoded their removal would pass
        // the assertion above, and the xyflow canvas could never use it.
        const a = actions();
        a.newAutomation = noop;
        a.newFromTemplate = noop;
        const ids = buildCanvasCommandGroups(t, ctx(), a)
            .flatMap((g) => g.commands.map((c) => c.id));
        expect(ids).toContain('new-automation');
        expect(ids).toContain('new-from-template');
        expect(ids).toHaveLength(25);
    });
});

describe('document commands need a map', () => {
    it('save and duplicate are off with no map open', () => {
        expect(off('save', { hasMap: false })).toBe(true);
        expect(off('duplicate', { hasMap: false })).toBe(true);
    });

    it('but creating a new map does not', () => {
        // Teeth: a builder that gated everything on `hasMap` would leave a
        // user with no map unable to make one.
        expect(off('new', { hasMap: false })).toBe(false);
        expect(off('new-automation', { hasMap: false })).toBe(false);
    });

    it('undo and redo follow their own flags', () => {
        expect(off('undo', { canUndo: false })).toBe(true);
        expect(off('redo', { canRedo: false })).toBe(true);
        expect(off('undo', { canUndo: true })).toBe(false);
        expect(off('redo', { canRedo: true })).toBe(false);
    });
});

describe('a write in flight disables the rest', () => {
    it('every command except the snap toggle', () => {
        const m = byId({ busy: true, selectionCount: 5 });
        const enabled = [...m.entries()].filter(([, c]) => c.disabled !== true).map(([id]) => id);
        expect(enabled).toEqual(['snap-toggle']);
    });

    it('and snap stays available, because it writes nothing', () => {
        // A view preference is the one thing still useful mid-save.
        expect(off('snap-toggle', { busy: true })).toBe(false);
    });
});

describe('layout commands need something to lay out', () => {
    it('whole-map arranges are off on an empty canvas', () => {
        for (const id of ['arrange-lr', 'arrange-tb', 'arrange-force']) {
            expect(off(id, { nodeCount: 0 })).toBe(true);
        }
    });

    it('selection arranges need two nodes, not one', () => {
        // Laying out ONE node moves it to the origin of its own private graph,
        // which looks like the node being flung away.
        for (const id of ['arrange-selection-lr', 'arrange-selection-tb', 'arrange-force-selection']) {
            expect(off(id, { selectionCount: 1 })).toBe(true);
            expect(off(id, { selectionCount: 2 })).toBe(false);
        }
    });

    it('a selection arrange does not care how many nodes exist elsewhere', () => {
        expect(off('arrange-selection-lr', { nodeCount: 2, selectionCount: 2 })).toBe(false);
    });
});

describe('the selection thresholds are three different numbers', () => {
    it('ungroup and delete need one', () => {
        expect(off('ungroup', { selectionCount: 0 })).toBe(true);
        expect(off('ungroup', { selectionCount: 1 })).toBe(false);
        expect(off('delete', { selectionCount: 0 })).toBe(true);
        expect(off('delete', { selectionCount: 1 })).toBe(false);
    });

    it('group and align need two', () => {
        expect(off('group', { selectionCount: 1 })).toBe(true);
        expect(off('group', { selectionCount: 2 })).toBe(false);
        for (const id of ['align-left', 'align-center-x', 'align-right',
                          'align-top', 'align-center-y', 'align-bottom']) {
            expect(off(id, { selectionCount: 1 })).toBe(true);
            expect(off(id, { selectionCount: 2 })).toBe(false);
        }
    });

    it('distribute needs THREE', () => {
        // Two shapes are already evenly spaced, so at two the command would
        // appear to do nothing. This is the threshold a flattened builder gets
        // wrong, and the one the live canvas is explicit about.
        for (const id of ['distribute-h', 'distribute-v']) {
            expect(off(id, { selectionCount: 2 })).toBe(true);
            expect(off(id, { selectionCount: 3 })).toBe(false);
        }
    });
});

describe('the snap toggle reports its state in the label', () => {
    it('on when enabled, off when not', () => {
        // A toggle whose label does not change leaves the user guessing which
        // way it is currently set.
        expect(byId({ snapEnabled: true }).get('snap-toggle')?.label).toBe('cmdSnapOnLabel');
        expect(byId({ snapEnabled: false }).get('snap-toggle')?.label).toBe('cmdSnapOffLabel');
    });
});

describe('the actions are wired to the right commands', () => {
    it('each layout command passes its own direction and scope', () => {
        const calls: Array<[string, string]> = [];
        const a = actions();
        a.arrange = (d, s) => calls.push([d, s]);
        const groups = buildCanvasCommandGroups(t, ctx({ selectionCount: 2 }), a);
        const find = (id: string) =>
            groups.flatMap((g) => g.commands).find((c) => c.id === id)!;
        find('arrange-lr').onSelect();
        find('arrange-tb').onSelect();
        find('arrange-selection-lr').onSelect();
        find('arrange-selection-tb').onSelect();
        expect(calls).toEqual([
            ['LR', 'all'], ['TB', 'all'], ['LR', 'selection'], ['TB', 'selection'],
        ]);
    });

    it('each align command passes its own edge', () => {
        const edges: string[] = [];
        const a = actions();
        a.align = (e) => edges.push(e);
        const groups = buildCanvasCommandGroups(t, ctx({ selectionCount: 2 }), a);
        for (const c of groups.flatMap((g) => g.commands)) {
            if (c.id.startsWith('align-')) c.onSelect();
        }
        expect(edges).toEqual([
            'left', 'center-horizontal', 'right', 'top', 'center-vertical', 'bottom',
        ]);
    });

    it('distribute passes its own axis', () => {
        const axes: string[] = [];
        const a = actions();
        a.distribute = (x) => axes.push(x);
        const groups = buildCanvasCommandGroups(t, ctx({ selectionCount: 3 }), a);
        for (const c of groups.flatMap((g) => g.commands)) {
            if (c.id.startsWith('distribute-')) c.onSelect();
        }
        expect(axes).toEqual(['horizontal', 'vertical']);
    });
});
