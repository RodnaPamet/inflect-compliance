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

/** No existing edges — the duplicate check has nothing to match. */
const NO_EDGES: { sourceKey: string; targetKey: string }[] = [];

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
        const out = validateEdge('note-1', 'g1', MAP, NO_EDGES);
        expect(out.map((r) => r.code)).toEqual(['NODE_IS_ANNOTATION', 'NODE_IS_GROUP']);
    });

    it('a self-edge reports the endpoint ONCE, plus the self-loop', () => {
        // #2998 reported both ends here, reasoning that "fixing one would leave
        // the user refused again". That holds for two DIFFERENT bad ends and
        // not for a self-edge: both ends are the same node, so fixing it fixes
        // both, and saying so twice is noise.
        const out = validateEdge('note-1', 'note-1', MAP, NO_EDGES);
        expect(out.map((r) => r.code)).toEqual(['NODE_IS_ANNOTATION', 'SELF_LOOP']);
    });

    it('a good edge returns nothing at all', () => {
        expect(validateEdge('n1', 'n2', MAP, NO_EDGES)).toEqual([]);
    });

    it('reports the bad end when only one is bad', () => {
        expect(validateEdge('n1', 'nope', MAP, NO_EDGES).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
        ]);
        expect(validateEdge('nope', 'n1', MAP, NO_EDGES).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
        ]);
    });

    it('an empty map refuses everything rather than accepting it', () => {
        // The vacuity case. A validator that found no nodes and shrugged would
        // accept every edge on a freshly loaded canvas.
        expect(validateEdge('n1', 'n2', [], NO_EDGES).map((r) => r.code)).toEqual([
            'UNKNOWN_NODE_KEY',
            'UNKNOWN_NODE_KEY',
        ]);
    });
});

// ─────────────────────────────────────────────────────────────────────
//  The two refusals the LIVE canvas enforces and #2998 did not.
// ─────────────────────────────────────────────────────────────────────

describe('SELF_LOOP — parity with the live canvas', () => {
    it('refuses an edge from a node to itself', () => {
        expect(validateEdge('n1', 'n1', MAP, NO_EDGES).map((r) => r.code)).toEqual([
            'SELF_LOOP',
        ]);
    });

    it('was ACCEPTED before this change — the regression being closed', () => {
        // Stated as a test because the whole point is that a valid-looking
        // graph could reach the database. Both endpoints resolve, neither is an
        // annotation or a group, so every #2998 refusal passes it.
        const endpointsAreFine =
            validateEdgeEndpoint('n1', MAP) === null;
        expect(endpointsAreFine).toBe(true);
        // …and yet the edge must be refused.
        expect(validateEdge('n1', 'n1', MAP, NO_EDGES)).not.toEqual([]);
    });

    it('is reported alongside a handle-less endpoint, not instead of it', () => {
        const out = validateEdge('g1', 'g1', MAP, NO_EDGES);
        expect(out.map((r) => r.code)).toEqual(['NODE_IS_GROUP', 'SELF_LOOP']);
    });
});

describe('DUPLICATE_EDGE — parity with the live canvas', () => {
    const existing = [{ sourceKey: 'n1', targetKey: 'n2' }];

    it('refuses a second edge for the same directed pair', () => {
        expect(validateEdge('n1', 'n2', MAP, existing).map((r) => r.code)).toEqual([
            'DUPLICATE_EDGE',
        ]);
    });

    it('ALLOWS the reverse direction — a,b and b,a are different edges', () => {
        // A process legitimately loops back through a rejection path. Comparing
        // unordered pairs would refuse this, which the live canvas permits.
        expect(validateEdge('n2', 'n1', MAP, existing)).toEqual([]);
    });

    it('allows an unrelated pair', () => {
        expect(validateEdge('n2', 'g1', MAP, existing).map((r) => r.code)).toEqual([
            'NODE_IS_GROUP',
        ]);
    });

    it('reports duplicate ALONGSIDE an endpoint refusal', () => {
        const dupToAnnotation = [{ sourceKey: 'n1', targetKey: 'note-1' }];
        expect(
            validateEdge('n1', 'note-1', MAP, dupToAnnotation).map((r) => r.code),
        ).toEqual(['NODE_IS_ANNOTATION', 'DUPLICATE_EDGE']);
    });

    it('an empty edge set refuses nothing on duplicate grounds', () => {
        // The vacuity control: with no existing edges, every pair is novel.
        expect(validateEdge('n1', 'n2', MAP, NO_EDGES)).toEqual([]);
    });
});

describe('every refusal code has distinct text', () => {
    it('five codes, five messages', () => {
        // A shared message would make two different problems look like one
        // problem, which is the thing separate codes exist to prevent.
        const messages = [
            describeRefusal({ code: 'UNKNOWN_NODE_KEY', nodeKey: 'x' }),
            describeRefusal({ code: 'NODE_IS_ANNOTATION', nodeKey: 'x', nodeType: 'annotation' }),
            describeRefusal({ code: 'NODE_IS_GROUP', nodeKey: 'x', nodeType: 'group' }),
            describeRefusal({ code: 'SELF_LOOP', nodeKey: 'x' }),
            describeRefusal({ code: 'DUPLICATE_EDGE', sourceKey: 'a', targetKey: 'b' }),
        ];
        expect(new Set(messages).size).toBe(5);
        expect(messages.every((m) => m.length > 0)).toBe(true);
    });
});
