/**
 * What an arrow between two shapes IS.
 *
 * `classifyArrow` is split out of the editor plumbing because this is where the
 * decisions are, and a decision reachable only through a mounted editor and a
 * simulated drag is one nobody tests the edges of.
 *
 * The distinction that matters throughout: an arrow bound at both ends to
 * process nodes is an EDGE and gets converted; anything else is an ANNOTATION
 * and is left alone. Getting that backwards in either direction is a real
 * defect — converting too eagerly steals a callout the user drew on purpose,
 * converting too rarely leaves a lookalike that persists to `freeformJson` and
 * is invisible to every `ProcessEdge` compliance query.
 */
import {
    classifyArrow,
    mintEdgeKey,
    type ArrowEnd,
} from '@/components/processes/tldraw/arrow-to-edge';
import type { KnownEdge, KnownNode } from '@/components/processes/tldraw/edge-validation';

const NODES: KnownNode[] = [
    { nodeKey: 'a', nodeType: 'processStep' },
    { nodeKey: 'b', nodeType: 'processStep' },
    { nodeKey: 'note', nodeType: 'annotation' },
    { nodeKey: 'grp', nodeType: 'group' },
];

const ends = (start: string | null, end: string | null): ArrowEnd[] => [
    { terminal: 'start', nodeKey: start },
    { terminal: 'end', nodeKey: end },
];

describe('an arrow bound to two process nodes is an edge', () => {
    it('converts, taking direction from the terminals', () => {
        expect(classifyArrow(ends('a', 'b'), NODES, [])).toEqual({
            kind: 'convert',
            sourceKey: 'a',
            targetKey: 'b',
            // Two `processStep`s are not an automation pair, so the
            // inference yields the generic document edge (#3093).
            edgeKind: 'flow',
        });
    });

    it('takes direction from the TERMINAL, not from array order', () => {
        // An arrow drawn right-to-left binds its `end` first, so ordering by
        // creation would invert half of all edges — and an inverted process
        // edge is still a valid edge, so nothing downstream would complain.
        const reversed: ArrowEnd[] = [
            { terminal: 'end', nodeKey: 'b' },
            { terminal: 'start', nodeKey: 'a' },
        ];
        expect(classifyArrow(reversed, NODES, [])).toEqual({
            kind: 'convert',
            sourceKey: 'a',
            targetKey: 'b',
            edgeKind: 'flow',
        });
    });

    it('permits the reverse edge alongside the forward one', () => {
        // Directed: `a -> b` and `b -> a` are different edges and both legal —
        // a process can loop back through a rejection path.
        const existing: KnownEdge[] = [{ sourceKey: 'a', targetKey: 'b' }];
        expect(classifyArrow(ends('b', 'a'), NODES, existing)).toEqual({
            kind: 'convert',
            sourceKey: 'b',
            targetKey: 'a',
            edgeKind: 'flow',
        });
    });
});

describe('anything else is an annotation, and is left alone', () => {
    it('one bound end — a callout pointing at a step', () => {
        const one: ArrowEnd[] = [{ terminal: 'start', nodeKey: 'a' }];
        expect(classifyArrow(one, NODES, [])).toEqual({
            kind: 'annotation',
            why: 'FEWER_THAN_TWO_ENDS',
        });
    });

    it('no bound ends — a free-floating arrow', () => {
        expect(classifyArrow([], NODES, [])).toEqual({
            kind: 'annotation',
            why: 'FEWER_THAN_TWO_ENDS',
        });
    });

    it('an end bound to something that is not a process node', () => {
        // A sticky note, a frame, another arrow. `nodeKey` is null because the
        // resolver found no process-node shape behind that id.
        expect(classifyArrow(ends('a', null), NODES, [])).toEqual({
            kind: 'annotation',
            why: 'END_IS_NOT_A_NODE',
        });
        expect(classifyArrow(ends(null, 'b'), NODES, [])).toEqual({
            kind: 'annotation',
            why: 'END_IS_NOT_A_NODE',
        });
    });

    it('two ends that are both the same terminal', () => {
        // Malformed rather than impossible: treated as annotation because there
        // is no source/target pair to build an edge out of. Reported as
        // FEWER_THAN_TWO_ENDS because that is what it is — two bindings, fewer
        // than two usable ends.
        const both: ArrowEnd[] = [
            { terminal: 'start', nodeKey: 'a' },
            { terminal: 'start', nodeKey: 'b' },
        ];
        expect(classifyArrow(both, NODES, [])).toEqual({
            kind: 'annotation',
            why: 'FEWER_THAN_TWO_ENDS',
        });
    });

    it('the not-a-node check runs BEFORE validation — teeth', () => {
        // Order matters. Validating first would report `UNKNOWN_NODE_KEY` for a
        // perfectly good annotation pointing at a sticky note, and the host
        // would toast an error at a user who did nothing wrong.
        const v = classifyArrow(ends(null, null), NODES, []);
        expect(v.kind).toBe('annotation');
        expect(v).not.toHaveProperty('refusals');
    });
});

describe('two nodes, but the edge is not allowed', () => {
    it('refuses a self-loop', () => {
        const v = classifyArrow(ends('a', 'a'), NODES, []);
        expect(v.kind).toBe('refuse');
        expect(v.kind === 'refuse' && v.refusals.map((r) => r.code)).toContain('SELF_LOOP');
    });

    it('refuses a duplicate of an existing edge', () => {
        const existing: KnownEdge[] = [{ sourceKey: 'a', targetKey: 'b' }];
        const v = classifyArrow(ends('a', 'b'), NODES, existing);
        expect(v.kind).toBe('refuse');
        expect(v.kind === 'refuse' && v.refusals.map((r) => r.code)).toContain('DUPLICATE_EDGE');
    });

    it('refuses an annotation node and a group node, as DISTINCT codes', () => {
        // `edge-validation` keeps these separate because the next action
        // differs: an annotation's edge belongs on the step it annotates, a
        // group's on a node inside it. Collapsing them would give one message
        // unhelpful in both cases.
        const toNote = classifyArrow(ends('a', 'note'), NODES, []);
        expect(toNote.kind === 'refuse' && toNote.refusals.map((r) => r.code)).toContain(
            'NODE_IS_ANNOTATION',
        );
        const toGroup = classifyArrow(ends('a', 'grp'), NODES, []);
        expect(toGroup.kind === 'refuse' && toGroup.refusals.map((r) => r.code)).toContain(
            'NODE_IS_GROUP',
        );
    });

    it('reports BOTH bad ends rather than the first', () => {
        const v = classifyArrow(ends('note', 'grp'), NODES, []);
        expect(v.kind).toBe('refuse');
        const codes = v.kind === 'refuse' ? v.refusals.map((r) => r.code) : [];
        expect(codes).toEqual(expect.arrayContaining(['NODE_IS_ANNOTATION', 'NODE_IS_GROUP']));
    });

    it('refuses an end whose key is not on the map', () => {
        const v = classifyArrow(ends('a', 'ghost'), NODES, []);
        expect(v.kind).toBe('refuse');
        expect(v.kind === 'refuse' && v.refusals.map((r) => r.code)).toContain('UNKNOWN_NODE_KEY');
    });
});

describe('mintEdgeKey', () => {
    it('does not collide within a millisecond', () => {
        // The reason `mintNodeKey` carries a random suffix, recorded there: a
        // timestamp alone collides, and a drag that binds both ends at once can
        // mint two in the same tick.
        const keys = new Set(Array.from({ length: 500 }, () => mintEdgeKey()));
        expect(keys.size).toBe(500);
    });

    it('is prefixed, so an id reads as an edge key', () => {
        expect(mintEdgeKey()).toMatch(/^edge-\d+-[a-z0-9]+$/);
    });
});

/**
 * VR-5's on-connect inference, restored with the canvas (#3093).
 *
 * The xyflow canvas called `inferEdgeKind` from `onConnect` with the two
 * endpoint node kinds, and that call site went with the canvas — leaving the
 * module with zero consumers, which two guards then recorded as an absence.
 * `classifyArrow` is now where it happens, which puts it in the pure function
 * this file exists to test rather than behind a mounted editor and a drag.
 */
describe('a drawn edge infers its automation kind from the endpoints', () => {
    const AUTO: KnownNode[] = [
        { nodeKey: 't', nodeType: 'trigger' },
        { nodeKey: 'c', nodeType: 'condition' },
        { nodeKey: 'x', nodeType: 'action' },
        { nodeKey: 'y', nodeType: 'action' },
        { nodeKey: 'g', nodeType: 'slaGate' },
        { nodeKey: 's', nodeType: 'processStep' },
        { nodeKey: 's2', nodeType: 'processStep' },
    ];
    const kindOf = (from: string, to: string): string | undefined => {
        const v = classifyArrow(ends(from, to), AUTO, []);
        return v.kind === 'convert' ? v.edgeKind : undefined;
    };

    it('trigger -> condition is the default automation flow', () => {
        expect(kindOf('t', 'c')).toBe('trigger-flow');
    });

    it('action -> action is a CHAIN, and action -> anything else is not', () => {
        // The one pair where the TARGET matters. Both arms asserted, because
        // reading only the source would make every `action` edge a chain and
        // the test for it would still pass.
        expect(kindOf('x', 'y')).toBe('chain-delay');
        expect(kindOf('x', 'c')).toBe('trigger-flow');
    });

    it('a branching source defaults to its POSITIVE branch', () => {
        // The negative branch is the user's pick, not an inference — the
        // inspector flips it. Defaulting to `condition-fail` would label a
        // freshly drawn edge as a failure path nobody chose.
        expect(kindOf('c', 'x')).toBe('condition-pass');
        expect(kindOf('g', 'x')).toBe('sla-pass');
    });

    it('and a DOCUMENT pair stays flow, so document maps are unaffected', () => {
        // The property that makes this safe to wire on every canvas rather
        // than only on AUTOMATION maps.
        //
        // TWO distinct steps, not one twice: `validateEdge` refuses a self-edge
        // and the verdict is then `refuse`, so the first draft of this read
        // `undefined` and would have passed had it been written as a negation.
        expect(kindOf('s', 's2')).toBe('flow');
    });

    it('every inferred kind is one the renderer can draw', () => {
        /*
            The seam between the two halves of VR-5, and the one a type cannot
            check: `inferEdgeKind` returns an `AutomationEdgeKind` while
            `edgeStrokeFor` takes a `string`, because `edgeKind` is a free
            string on the wire. So a kind could be inferred that the renderer
            falls through to the default arm for — drawn as an ordinary flow
            edge, saved as something else, with nothing failing anywhere.
        */
        const { edgeStrokeFor } = require('@/components/processes/tldraw/process-edge-shape');
        const pairs: Array<[string, string]> = [
            ['t', 'c'],
            ['c', 'x'],
            ['x', 'y'],
            ['x', 'c'],
            ['g', 'x'],
        ];
        for (const [from, to] of pairs) {
            const kind = kindOf(from, to)!;
            expect(edgeStrokeFor(kind).stroke).toMatch(/^var\(--/);
        }
    });
});
