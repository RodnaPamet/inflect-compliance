/**
 * The selection adapter — the seam that keeps the inspector engine-agnostic.
 *
 * Two properties are worth pinning, and one of them only became visible when the
 * adapter's type was written down.
 *
 *   1. **Node wins when both are selected.** This lived as a comment on the
 *      inspector's props and as an `if` in its body, so it could only be checked
 *      by mounting a canvas. As a function it is checkable here.
 *
 *   2. **A label reaches the inspector only if it is a string.** xyflow types
 *      `Edge.label` as `ReactNode`, so a number or an element satisfies it — and
 *      the edge inspector renders it into a text input. Coercing a non-string
 *      would put `[object Object]` in the field and then SAVE it, turning a
 *      rendering choice into persisted data.
 *
 * The three-state label (`absent` / `null` / `string`) is asserted separately
 * from the narrowing, because collapsing `null` into `undefined` would make "the
 * user cleared this label" indistinguishable from "this edge never had one".
 */
import {
    resolveSelection,
    toSelectedEdge,
    toSelectedNode,
} from '@/lib/processes/canvas-selection';

describe('resolveSelection — node wins', () => {
    const node = { id: 'n1', data: null };
    const edge = { id: 'e1', data: null };

    it('resolves to the node when both are selected', () => {
        // Not arbitrary: the node panel carries type, size, linked entity and
        // the BIA affordance, so resolving to the edge would hide the richer one.
        expect(resolveSelection(node, edge)).toEqual({ kind: 'node', node });
    });

    it('resolves to the edge when only an edge is selected', () => {
        expect(resolveSelection(null, edge)).toEqual({ kind: 'edge', edge });
    });

    it('resolves to the node when only a node is selected', () => {
        expect(resolveSelection(node, null)).toEqual({ kind: 'node', node });
    });

    it('resolves to none when nothing is selected', () => {
        expect(resolveSelection(null, null)).toEqual({ kind: 'none' });
        expect(resolveSelection(undefined, undefined)).toEqual({ kind: 'none' });
    });

    it('the three kinds are genuinely three — the control', () => {
        // Without this, an implementation returning `{kind:'node'}` for every
        // input would satisfy two of the four assertions above.
        const kinds = [
            resolveSelection(node, edge).kind,
            resolveSelection(null, edge).kind,
            resolveSelection(null, null).kind,
        ];
        expect(new Set(kinds).size).toBe(3);
    });
});

describe('toSelectedNode', () => {
    it('carries the id and data, and nothing else', () => {
        // Geometry, selection state and z-index belong to the renderer. If one
        // of them appears here, the inspector has started reading it.
        const out = toSelectedNode({
            id: 'n1',
            data: { nodeType: 'processStep' },
            // Fields a real engine record carries, which must NOT survive.
            position: { x: 1, y: 2 },
            selected: true,
            zIndex: 7,
        } as Parameters<typeof toSelectedNode>[0]);
        expect(out).toEqual({ id: 'n1', data: { nodeType: 'processStep' } });
    });

    it('normalises a missing data to null rather than leaving it undefined', () => {
        expect(toSelectedNode({ id: 'n1' })).toEqual({ id: 'n1', data: null });
    });

    it('passes null and undefined straight through', () => {
        expect(toSelectedNode(null)).toBeNull();
        expect(toSelectedNode(undefined)).toBeNull();
    });
});

describe('toSelectedEdge — the label is narrowed, not coerced', () => {
    it('keeps a string label', () => {
        expect(toSelectedEdge({ id: 'e1', label: 'rejected' })).toEqual({
            id: 'e1',
            data: null,
            label: 'rejected',
        });
    });

    it('DROPS a non-string label rather than stringifying it', () => {
        // xyflow types `label` as ReactNode. A number would coerce silently and
        // a React element would become "[object Object]" — which the inspector
        // would then show in a text input and save on blur.
        expect(toSelectedEdge({ id: 'e1', label: 42 })).toEqual({
            id: 'e1',
            data: null,
        });
        expect('label' in toSelectedEdge({ id: 'e1', label: 42 })!).toBe(false);
        expect(
            toSelectedEdge({ id: 'e1', label: { type: 'div' } }),
        ).toEqual({ id: 'e1', data: null });
    });

    it('preserves an explicit null — a CLEARED label is not an absent one', () => {
        // The inspector writes null to clear a label. Folding it into undefined
        // would make "cleared" and "never had one" the same state, and the
        // difference is what tells a save whether to write.
        const out = toSelectedEdge({ id: 'e1', label: null });
        expect(out).toEqual({ id: 'e1', data: null, label: null });
        expect('label' in out!).toBe(true);
        expect(out!.label).toBeNull();
    });

    it('omits the key entirely when the record has no label', () => {
        const out = toSelectedEdge({ id: 'e1' });
        expect('label' in out!).toBe(false);
    });

    it('the three label states are distinguishable', () => {
        // absent / null / string — asserted together, because each pair being
        // distinct is the property, not any one of them in isolation.
        const absent = toSelectedEdge({ id: 'e1' })!;
        const cleared = toSelectedEdge({ id: 'e1', label: null })!;
        const set = toSelectedEdge({ id: 'e1', label: 'x' })!;
        expect([
            'label' in absent,
            'label' in cleared ? cleared.label : 'MISSING',
            set.label,
        ]).toEqual([false, null, 'x']);
    });

    it('passes null and undefined straight through', () => {
        expect(toSelectedEdge(null)).toBeNull();
        expect(toSelectedEdge(undefined)).toBeNull();
    });
});
