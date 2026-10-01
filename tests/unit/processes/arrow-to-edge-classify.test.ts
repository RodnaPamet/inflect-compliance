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
