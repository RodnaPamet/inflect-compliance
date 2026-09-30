/**
 * An edge's endpoints, refused at draw time.
 *
 * The claim worth pinning is that there are THREE refusals and they stay
 * distinct. Collapsing "this node cannot take edges" into one code would be
 * invisible in a diff and would produce one message that is unhelpful for both
 * cases it covers — an annotation and a group need the user to do different
 * things next.
 *
 * The handle-less set is driven from `NODE_TAXONOMY` so it cannot drift away
 * from the shape layer, and asserted BY NAME so a change to it is a review
 * question rather than something these tests silently follow.
 */
import {
    describeRefusal,
    validateEdge,
    validateEdgeEndpoint,
    type KnownNode,
} from '@/components/processes/tldraw/edge-validation';
import {
    NODE_TAXONOMY,
    type ProcessNodeKind,
} from '@/components/processes/node-taxonomy';

const node = (nodeKey: string, nodeType: string): KnownNode => ({ nodeKey, nodeType });

const MAP: KnownNode[] = [
    node('n1', 'processStep'),
    node('n2', 'decision'),
    node('note-1', 'annotation'),
    node('g1', 'group'),
    node('odd-1', 'aKindFromTheFuture'),
];

describe('a valid endpoint is accepted', () => {
    it.each(
        (Object.keys(NODE_TAXONOMY) as ProcessNodeKind[]).filter(
            (k) => NODE_TAXONOMY[k].hasHandles,
        ),
    )('%s can take an edge', (kind) => {
        expect(validateEdgeEndpoint('x', [node('x', kind)])).toBeNull();
    });

    it('covers the ten edge-capable kinds — the population control', () => {
        // If the taxonomy shrank to nothing, every `it.each` above would
        // vanish and this file would pass by having nothing to say.
        const capable = (Object.keys(NODE_TAXONOMY) as ProcessNodeKind[]).filter(
            (k) => NODE_TAXONOMY[k].hasHandles,
        );
        expect(capable.length).toBe(10);
    });
});

describe('three refusals, and they stay distinct', () => {
    it('a key the map does not contain is UNKNOWN_NODE_KEY', () => {
        expect(validateEdgeEndpoint('nope', MAP)).toEqual({
            code: 'UNKNOWN_NODE_KEY',
            nodeKey: 'nope',
        });
    });

    it('an annotation is its OWN code, not a generic refusal', () => {
        expect(validateEdgeEndpoint('note-1', MAP)).toEqual({
            code: 'NODE_IS_ANNOTATION',
            nodeKey: 'note-1',
            nodeType: 'annotation',
        });
    });

    it('a group is its OWN code, not the annotation one', () => {
        // The two were reported as one for a while. If a refactor ever
        // collapses them, this is what notices.
        expect(validateEdgeEndpoint('g1', MAP)).toEqual({
            code: 'NODE_IS_GROUP',
            nodeKey: 'g1',
            nodeType: 'group',
        });
    });

    it('the three codes are genuinely three', () => {
        const codes = [
            validateEdgeEndpoint('nope', MAP),
            validateEdgeEndpoint('note-1', MAP),
            validateEdgeEndpoint('g1', MAP),
        ].map((r) => r?.code);
        expect(new Set(codes).size).toBe(3);
    });

    it('their messages differ, which is the reason they are separate', () => {
        const messages = [
            describeRefusal({ code: 'UNKNOWN_NODE_KEY', nodeKey: 'nope' }),
            describeRefusal({ code: 'NODE_IS_ANNOTATION', nodeKey: 'note-1', nodeType: 'annotation' }),
            describeRefusal({ code: 'NODE_IS_GROUP', nodeKey: 'g1', nodeType: 'group' }),
        ];
        expect(new Set(messages).size).toBe(3);
        // Each points at the action that actually resolves it.
        expect(messages[1]).toContain('annotates');
        expect(messages[2]).toContain('inside');
    });
});

describe('an unknown kind is edge-capable', () => {
    it('a kind this build has never seen can still take edges', () => {
        // It falls back to `external`, which has handles. Refusing edges to a
        // node we merely do not recognise would drop real edges on load and
        // lose them on the next save.
        expect(validateEdgeEndpoint('odd-1', MAP)).toBeNull();
    });
});

describe('both ends are reported together', () => {
    it('returns TWO refusals when both ends are bad', () => {
        // Returning only the first would have the user fix one end, press
        // save, and be refused again for the other.
        const out = validateEdge('note-1', 'g1', MAP);
        expect(out.map((r) => r.code)).toEqual(['NODE_IS_ANNOTATION', 'NODE_IS_GROUP']);
    });

    it('a self-edge on a handle-less node reports BOTH ends', () => {
        const out = validateEdge('note-1', 'note-1', MAP);
        expect(out).toHaveLength(2);
        expect(out.every((r) => r.code === 'NODE_IS_ANNOTATION')).toBe(true);
    });

    it('a good edge returns nothing at all', () => {
        expect(validateEdge('n1', 'n2', MAP)).toEqual([]);
    });

    it('reports the bad end when only one is bad', () => {
        expect(validateEdge('n1', 'nope', MAP).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
        ]);
        expect(validateEdge('nope', 'n1', MAP).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
        ]);
    });

    it('an empty map refuses everything rather than accepting it', () => {
        // The vacuity case. A validator that found no nodes and shrugged would
        // accept every edge on a freshly loaded canvas.
        expect(validateEdge('n1', 'n2', []).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
            'UNKNOWN_NODE_KEY',
        ]);
    });
});
