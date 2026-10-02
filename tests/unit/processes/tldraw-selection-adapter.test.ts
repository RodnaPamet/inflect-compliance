/**
 * @jest-environment jsdom
 *
 * The inspector's selection and write path, on tldraw.
 *
 * ── What only this can be wrong about ────────────────────────────────
 *
 * `ProcessInspector` is reused unchanged and has its own tests;
 * `toSelectedNode` / `resolveSelection` have theirs. What is new here is the
 * TRANSLATION: which record a click resolves to, which identifier the inspector
 * is handed, and where a patch lands. Three of those are easy to get subtly
 * wrong in ways that work until they don't:
 *
 *   • handing over the SHAPE ID instead of the `nodeKey` — correct until the
 *     first node created by drawing one, whose id is random;
 *   • resolving a clicked LINE to the line itself rather than to its binding,
 *     which holds every field the edge inspector edits;
 *   • replacing `dataJson` instead of merging into it, which drops every
 *     sibling key the opaque column was carrying.
 */
import { renderHook, act } from '@testing-library/react';

import { useTldrawSelection } from '@/lib/processes/use-tldraw-selection';

const NODE_SHAPE = {
    id: 'shape:abc123',
    type: 'process-node',
    props: {
        nodeKey: 'n1',
        nodeType: 'processStep',
        label: 'Receive',
        subtitle: null,
        dataJson: { existing: 'keep-me' },
    },
};

const LINE_SHAPE = { id: 'shape:edge-e1', type: 'process-edge-line', props: { edgeKey: 'e1' } };

const BINDING = {
    id: 'binding:b1',
    typeName: 'binding',
    type: 'process-edge',
    fromId: 'shape:abc123',
    toId: 'shape:def456',
    props: {
        edgeKey: 'e1',
        sourceKey: 'n1',
        targetKey: 'n2',
        edgeKind: 'flow',
        labelOverride: 'approves',
        dataJson: null,
        controls: [],
    },
};

function fakeEditor(selected: unknown[] = [], records: unknown[] = [BINDING]) {
    let listener: (() => void) | null = null;
    const shapeUpdates: Array<Record<string, unknown>> = [];
    const bindingUpdates: Array<Record<string, unknown>> = [];
    const marks: number[] = [];
    let sel = selected;
    return {
        editor: {
            getSelectedShapes: () => sel,
            getCurrentPageShapes: () => [NODE_SHAPE, LINE_SHAPE],
            markHistoryStoppingPoint: () => marks.push(1),
            updateShape: (p: Record<string, unknown>) => shapeUpdates.push(p),
            updateBinding: (p: Record<string, unknown>) => bindingUpdates.push(p),
            store: {
                allRecords: () => records,
                listen: (fn: () => void) => {
                    listener = fn;
                    return () => { listener = null; };
                },
            },
        },
        select(next: unknown[]) { sel = next; listener?.(); },
        shapeUpdates,
        bindingUpdates,
        marks,
        isListening: () => listener !== null,
    };
}

describe('a selected NODE reaches the inspector by KEY', () => {
    it('hands over props.nodeKey, not the shape id', () => {
        // The shape id is random for a node the user drew; its key lives only
        // in props. Passing the id would work until exactly that case.
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.node?.id).toBe('n1');
        expect(h.result.current.node?.id).not.toBe(NODE_SHAPE.id);
    });

    it('carries the props as the inspector`s data', () => {
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.node?.data).toMatchObject({ label: 'Receive' });
    });

    it('and resolves to the node when both are selected', () => {
        // `resolveSelection`'s node-wins rule, reused rather than restated.
        const f = fakeEditor([NODE_SHAPE, LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.selection.kind).toBe('node');
    });
});

describe('a selected LINE resolves to its BINDING', () => {
    it('because the line carries geometry and the binding carries the data', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.edge?.id).toBe('e1');
        expect(h.result.current.edge?.data).toMatchObject({ edgeKind: 'flow' });
        expect(h.result.current.edge?.label).toBe('approves');
    });

    it('and is null when no binding carries that key', () => {
        // A line whose binding is gone must not present an edge with no data.
        const f = fakeEditor([LINE_SHAPE], []);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.edge).toBeNull();
    });

    it('nothing selected is nothing selected', () => {
        const f = fakeEditor([]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.selection.kind).toBe('none');
    });
});

describe('selection is OBSERVED, not read once', () => {
    it('updates when the store reports a new selection', () => {
        const f = fakeEditor([]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        expect(h.result.current.node).toBeNull();
        act(() => f.select([NODE_SHAPE]));
        expect(h.result.current.node?.id).toBe('n1');
    });

    it('unsubscribes on unmount', () => {
        const f = fakeEditor([]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        h.unmount();
        expect(f.isListening()).toBe(false);
    });
});

describe('the node write path', () => {
    it('writes label and subtitle to props', () => {
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { label: 'Renamed', subtitle: 'AP' }));
        expect(f.shapeUpdates[0]).toMatchObject({
            props: { label: 'Renamed', subtitle: 'AP' },
        });
    });

    it('MERGES linkedEntityId into dataJson instead of replacing it', () => {
        // `dataJson` is an opaque passthrough carrying whatever else the row
        // holds. A whole-value write would silently drop every sibling key.
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { linkedEntityId: 'ctl_1' }));
        expect(f.shapeUpdates[0]!.props).toEqual({
            dataJson: { existing: 'keep-me', linkedEntityId: 'ctl_1' },
        });
    });

    it('DROPS size, and drops it visibly rather than writing a no-op', () => {
        // `size` persists to `dataJson.size` but the tldraw shape renders at
        // its defaults and never reads it, so applying it would save a value
        // that changes nothing the user can see. #2961 tracks hiding the
        // control; this asserts the patch is not half-applied meanwhile.
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { size: 'large' }));
        expect(f.shapeUpdates).toHaveLength(0);
    });

    it('still applies the rest when size rides along with it', () => {
        // Teeth for the above: dropping the whole patch because it mentions
        // size would lose a legitimate label edit made in the same commit.
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { size: 'large', label: 'Kept' }));
        expect(f.shapeUpdates[0]!.props).toEqual({ label: 'Kept' });
    });

    it('marks one history stopping point per commit', () => {
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { label: 'x' }));
        expect(f.marks).toHaveLength(1);
    });

    it('finds a DRAWN node, whose shape id is random and not derived from its key', () => {
        // The fixture's id is `shape:abc123`, which is what a node created by
        // drawing one looks like — its `nodeKey` exists only in props. An
        // adapter resolving through `shapeIdForNodeKey` misses it entirely and
        // returns early, so the inspector edit vanishes with no error.
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('n1', { label: 'Edited' }));
        expect(f.shapeUpdates[0]).toMatchObject({ id: 'shape:abc123' });
    });

    it('does nothing for a node that is not in the store', () => {
        const f = fakeEditor([NODE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onUpdate('does-not-exist', { label: 'x' }));
        expect(f.shapeUpdates).toHaveLength(0);
    });
});

describe('the edge write path', () => {
    it('renames variant to edgeKind, which is what the row calls it', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { variant: 'conditional' }));
        expect(f.bindingUpdates[0]).toMatchObject({ props: { edgeKind: 'conditional' } });
    });

    it('writes a NULL label, because null means clear', () => {
        // `labelOverride` is nullable and the inspector sends null to clear it.
        // Treating null as "no change" would make the clear button inert.
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { label: null }));
        expect(f.bindingUpdates[0]!.props).toEqual({ labelOverride: null });
    });

    it('carries controls through', () => {
        const controls = [{ controlKey: 'c1', label: 'Approval', controlId: 'ctl_1', dataJson: null }];
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { controls }));
        expect(f.bindingUpdates[0]!.props).toEqual({ controls });
    });

    it('does nothing for an edge key the store does not hold', () => {
        const f = fakeEditor([LINE_SHAPE], []);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('nope', { variant: 'flow' }));
        expect(f.bindingUpdates).toHaveLength(0);
    });
});

/**
 * The DRAWN line keeps its own copy of `edgeKind` (#3090), because the binding
 * is not cheaply findable from the line: the binding joins the two NODE shapes
 * and the line is a third record neither end references, so a lookup means
 * scanning the store per line per render.
 *
 * Every other way the line gets its kind is a reload, which re-derives it. The
 * inspector's variant cycle is the one write that is not, so it is the one
 * place that has to keep the two in step — and without it the variant saves,
 * survives a reload, and changes nothing on screen until then.
 */
describe('a variant change also redraws the line', () => {
    it('updates the LINE as well as the binding', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { variant: 'reference' }));
        expect(f.bindingUpdates[0]).toMatchObject({ props: { edgeKind: 'reference' } });
        expect(f.shapeUpdates[0]).toMatchObject({
            id: 'shape:edge-e1',
            props: { edgeKind: 'reference' },
        });
    });

    it('addresses the line by its DERIVED id, not the binding id', () => {
        // `shapeIdForEdgeKey` is the only way to reach the line: it is keyed by
        // the edge key, and the binding's own id names a different record.
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { variant: 'conditional' }));
        expect(f.shapeUpdates[0]!.id).toBe('shape:edge-e1');
        expect(f.shapeUpdates[0]!.id).not.toBe('binding:b1');
    });

    it('writes the variant and the chip, and NOT the label', () => {
        /*
            This assertion used to read "a label-only change leaves the line
            ALONE", which was true while the variant was the only mirrored prop
            and became false the moment the label started mirroring too.
            Its job was teeth for the `!== undefined` guards — that every edge
            edit must not rewrite an unrelated line prop to `undefined`, which a
            `T.string` record rejects. That job now belongs to the controls-only
            case below, and what is worth asserting here is the narrower claim
            the patch builder actually makes.

            `chipLabel: ''` joins it for #3093: a variant change can move an
            edge off an automation kind, and the chip has to go with it. The
            exact `toEqual` is deliberate — it is what keeps `label` out, and a
            widened `toMatchObject` would admit the `undefined` this guards.
        */
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { variant: 'conditional' }));
        expect(f.shapeUpdates).toHaveLength(1);
        expect(f.shapeUpdates[0]!.props).toEqual({ edgeKind: 'conditional', chipLabel: '' });
    });

    it('and an unknown edge key touches neither record', () => {
        const f = fakeEditor([LINE_SHAPE], []);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('nope', { variant: 'reference' }));
        expect(f.bindingUpdates).toHaveLength(0);
        expect(f.shapeUpdates).toHaveLength(0);
    });
});

/** The label is the second mirrored prop, and clears are the interesting case. */
describe('a label change also redraws the line (#3093)', () => {
    it('writes the new label to the line', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { label: 'approves' }));
        expect(f.shapeUpdates[0]).toMatchObject({ props: { label: 'approves' } });
    });

    it('a NULL label clears the line to empty, not to null', () => {
        // `null` means CLEAR on the binding, whose column is nullable. The
        // line's prop is `T.string`, so a null written through would fail
        // validation on a record tldraw is about to re-render.
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { label: null }));
        expect(f.bindingUpdates[0]).toMatchObject({ props: { labelOverride: null } });
        expect(f.shapeUpdates[0]).toMatchObject({ props: { label: '' } });
    });

    it("an EMPTY-STRING label is also a clear, not a no-op", () => {
        // `?? ''` and not a truthiness check: `''` is falsy, and a falsy test
        // would skip the line update and leave the old label drawn.
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { label: '' }));
        expect(f.shapeUpdates).toHaveLength(1);
        expect(f.shapeUpdates[0]).toMatchObject({ props: { label: '' } });
    });

    it('a label AND a variant together are ONE shape update, so one undo', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() =>
            h.result.current.onEdgeUpdate('e1', { label: 'if rejected', variant: 'conditional' }),
        );
        expect(f.shapeUpdates).toHaveLength(1);
        expect(f.shapeUpdates[0]).toMatchObject({
            props: { label: 'if rejected', edgeKind: 'conditional' },
        });
    });

    it('EITHER edit clears the chip, because a chip only shows without a label', () => {
        /*
            The asymmetry worth pinning (#3093). A chip renders only on an edge
            with no label, so typing one must remove it — and changing the
            variant away from an automation kind must too.

            CLEARED rather than recomputed: this adapter has no translator, and
            the chip's text is localised. That is sound because an inspector edit
            can only ever REMOVE a chip, never add one — the variant cycle offers
            `flow`/`conditional`/`reference` only, so no edit here can turn an
            edge INTO an automation kind. The next load resolves anything else.
        */
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { label: 'typed' }));
        expect(f.shapeUpdates[0]).toMatchObject({ props: { chipLabel: '' } });

        const g = fakeEditor([LINE_SHAPE]);
        const h2 = renderHook(() => useTldrawSelection(g.editor as never));
        act(() => h2.result.current.onEdgeUpdate('e1', { variant: 'reference' }));
        expect(g.shapeUpdates[0]).toMatchObject({ props: { chipLabel: '' } });
    });

    it('a controls-only change still leaves the line alone', () => {
        const f = fakeEditor([LINE_SHAPE]);
        const h = renderHook(() => useTldrawSelection(f.editor as never));
        act(() => h.result.current.onEdgeUpdate('e1', { controls: [] }));
        expect(f.bindingUpdates).toHaveLength(1);
        expect(f.shapeUpdates).toHaveLength(0);
    });
});
