/**
 * `rows → tldraw → rows` must be the identity.
 *
 * ═══ WHY THIS IS THE LOAD-BEARING TEST OF THE WHOLE MIGRATION ═══
 *
 * #2963 names the consequence: if a load/save cycle with no user edit does not
 * produce an identical row set, **autosave writes spurious versions forever and
 * every diff becomes noise**. Not a rendering bug — a corruption of the version
 * history, arriving silently, on a 3-second debounce.
 *
 * So the assertions here are `toEqual` on the whole row set rather than
 * field-by-field spot checks. A spot check passes while the field nobody
 * thought of drifts, and the fields nobody thinks of are exactly the optional
 * ones where `undefined` and `null` are both legal on the wire.
 *
 * ═══ THE FIXTURES ARE DELIBERATELY AWKWARD ═══
 *
 * A round-trip over tidy data proves nothing about the cases that break it. The
 * graph below carries: every optional present, every optional absent, every
 * optional explicitly null, a node with a parent, an edge with controls, an
 * edge with NO controls, negative and fractional coordinates, and a freeform
 * sticky note that must never become a row.
 */
import {
    EdgeEndpointError,
    partitionCanvas,
    rowsToTldraw,
    tldrawToRows,
    type CanvasRecord,
    type GraphRows,
} from '@/components/processes/tldraw/serializer';
import { shapeIdForNodeKey } from '@/components/processes/tldraw/process-node-shape';

/** As the repository would hand them back: every optional resolved to null. */
const ROWS: GraphRows = {
    nodes: [
        {
            nodeKey: 'n1',
            nodeType: 'processStep',
            label: 'Receive invoice',
            subtitle: 'AP team',
            posX: 0,
            posY: 0,
            parentNodeKey: null,
            dataJson: null,
        },
        {
            nodeKey: 'n2',
            nodeType: 'decision',
            label: 'Over threshold?',
            subtitle: null,
            // Negative and fractional — a real canvas has both, and an integer
            // round trip would hide a coercion.
            posX: -412.5,
            posY: 96.25,
            parentNodeKey: 'g1',
            dataJson: { branchLabels: { yes: 'Escalate', no: 'Pay' } },
        },
        {
            nodeKey: 'g1',
            nodeType: 'group',
            label: 'Approval',
            subtitle: null,
            posX: 500,
            posY: 0,
            parentNodeKey: null,
            dataJson: null,
        },
    ],
    edges: [
        {
            edgeKey: 'e1',
            sourceKey: 'n1',
            targetKey: 'n2',
            edgeKind: 'flow',
            labelOverride: null,
            dataJson: null,
            controls: [],
        },
        {
            edgeKey: 'e2',
            sourceKey: 'n2',
            targetKey: 'n1',
            edgeKind: 'exception',
            labelOverride: 'rejected',
            dataJson: { dashed: true },
            controls: [
                {
                    controlKey: 'c1',
                    label: 'Segregation of duties',
                    controlId: 'ctl_abc123',
                    dataJson: null,
                },
            ],
        },
    ],
};

const STICKY: CanvasRecord = {
    id: 'shape:sticky-1',
    type: 'note',
    x: 10,
    y: 10,
    props: { text: 'STICKY-NOT-A-ROW' },
};

describe('rows → tldraw → rows is the identity', () => {
    it('reproduces the row set EXACTLY, whole-object', () => {
        expect(tldrawToRows(rowsToTldraw(ROWS))).toEqual(ROWS);
    });

    it('stays exact over repeated cycles — drift compounds or it does not exist', () => {
        // One cycle can be exact while each one shifts something that only
        // shows up on the third. Autosave runs this hundreds of times a session.
        let g = rowsToTldraw(ROWS);
        for (let i = 0; i < 5; i++) g = rowsToTldraw(tldrawToRows(g), g.freeform);
        expect(tldrawToRows(g)).toEqual(ROWS);
    });

    it('produces DETERMINISTIC ids, so a no-edit save is a no-op diff', () => {
        const a = rowsToTldraw(ROWS);
        const b = rowsToTldraw(ROWS);
        expect(a.shapes.map((s) => s.id)).toEqual(b.shapes.map((s) => s.id));
        expect(a.bindings.map((x) => x.id)).toEqual(b.bindings.map((x) => x.id));
        // And the ids are derived from the keys, not invented.
        expect(a.shapes.map((s) => s.id)).toEqual(ROWS.nodes.map((n) => shapeIdForNodeKey(n.nodeKey)));
    });
});

describe('undefined normalises to null on the way in', () => {
    it('an optional OMITTED on the wire round-trips as null', () => {
        // The wire schema admits `undefined`; the row stores `null`. Normalising
        // one direction only is how a projection acquires a difference that is
        // invisible to read and fatal to toEqual.
        const sparse: GraphRows = {
            nodes: [
                {
                    nodeKey: 'x1',
                    nodeType: 'processStep',
                    label: 'Bare',
                    posX: 1,
                    posY: 2,
                } as GraphRows['nodes'][number],
            ],
            edges: [],
        };
        const out = tldrawToRows(rowsToTldraw(sparse));
        expect(out.nodes[0]).toEqual({
            nodeKey: 'x1',
            nodeType: 'processStep',
            label: 'Bare',
            posX: 1,
            posY: 2,
            subtitle: null,
            parentNodeKey: null,
            dataJson: null,
        });
    });

    it('the INTERMEDIATE representation carries null, not undefined', () => {
        // The round trip alone cannot prove this: normalisation runs on BOTH
        // sides, so removing the inbound `?? null` is masked by the outbound
        // one and every identity assertion still passes. Verified by mutation —
        // dropping `subtitle ?? null` in `rowsToTldraw` left 14/14 green.
        //
        // It still matters, for a reason the row set never shows: the shape's
        // prop validator is `T.string.nullable()`, which accepts null and
        // REJECTS undefined. A shape carrying `subtitle: undefined` would be
        // refused by the editor at create time, and the failure would arrive as
        // a canvas that will not open rather than as a bad row.
        const sparse: GraphRows = {
            nodes: [
                {
                    nodeKey: 'x1',
                    nodeType: 'processStep',
                    label: 'Bare',
                    posX: 1,
                    posY: 2,
                } as GraphRows['nodes'][number],
            ],
            edges: [],
        };
        const props = rowsToTldraw(sparse).shapes[0]!.props;
        // `toBeNull`, not `toBeUndefined`/`toBeFalsy` — the distinction IS the
        // assertion, and a loose matcher would accept exactly what it forbids.
        expect(props.subtitle).toBeNull();
        expect(props.parentNodeKey).toBeNull();
        expect(props.dataJson).toBeNull();
        expect('subtitle' in props).toBe(true);
    });

    it("a CONTROL's omitted dataJson normalises too — the subset least likely to be fixtured", () => {
        const withControl: GraphRows = {
            nodes: [
                { nodeKey: 'a', nodeType: 'processStep', label: 'A', subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null },
                { nodeKey: 'b', nodeType: 'processStep', label: 'B', subtitle: null, posX: 9, posY: 0, parentNodeKey: null, dataJson: null },
            ],
            edges: [
                {
                    edgeKey: 'e',
                    sourceKey: 'a',
                    targetKey: 'b',
                    edgeKind: 'flow',
                    labelOverride: null,
                    dataJson: null,
                    controls: [
                        { controlKey: 'c', label: 'L', controlId: 'ctl_1' } as GraphRows['edges'][number]['controls'][number],
                    ],
                },
            ],
        };
        expect(tldrawToRows(rowsToTldraw(withControl)).edges[0]!.controls[0]).toEqual({
            controlKey: 'c',
            label: 'L',
            controlId: 'ctl_1',
            dataJson: null,
        });
    });
});

describe('geometry comes from the shape, never from props', () => {
    it('a moved node round-trips its NEW position', () => {
        // Dragging updates x/y and nothing else. Reading position from props or
        // dataJson would silently discard every move the user made.
        const g = rowsToTldraw(ROWS);
        g.shapes[0]!.x = 1234.5;
        g.shapes[0]!.y = -6.75;
        const out = tldrawToRows(g);
        expect(out.nodes[0]!.posX).toBe(1234.5);
        expect(out.nodes[0]!.posY).toBe(-6.75);
    });
});

describe('freeform never becomes a row', () => {
    it('a sticky note on the canvas produces NO node', () => {
        const g = rowsToTldraw(ROWS, [STICKY as never]);
        const out = tldrawToRows(g);
        expect(out.nodes).toHaveLength(ROWS.nodes.length);
        expect(JSON.stringify(out)).not.toContain('STICKY-NOT-A-ROW');
    });

    it('and the sticky IS carried, which is what makes the above mean something', () => {
        // Without this, a projection that silently dropped freeform would
        // satisfy the assertion above perfectly.
        const g = rowsToTldraw(ROWS, [STICKY as never]);
        expect(JSON.stringify(g.freeform)).toContain('STICKY-NOT-A-ROW');
    });

    it('a non-process shape smuggled into `shapes` is IGNORED, not turned into a row', () => {
        // The realistic shape of this failure. A caller that hands the whole
        // canvas to `tldrawToRows` without partitioning first — which a real
        // store makes easy, since it returns everything — must not get a sticky
        // note back as a ProcessNode.
        //
        // Verified by mutation: removing the filter inside `tldrawToRows` left
        // 14/14 green, because every other test passes freeform through the
        // separate slot where it trivially cannot become a row.
        const g = rowsToTldraw(ROWS);
        const polluted = {
            ...g,
            shapes: [...g.shapes, STICKY as unknown as (typeof g.shapes)[number]],
        };
        const out = tldrawToRows(polluted);
        expect(out.nodes).toHaveLength(ROWS.nodes.length);
        expect(JSON.stringify(out.nodes)).not.toContain('STICKY-NOT-A-ROW');
    });

    it('partitionCanvas sorts a mixed canvas three ways', () => {
        const g = rowsToTldraw(ROWS);
        const mixed: CanvasRecord[] = [...g.shapes, ...g.bindings, STICKY];
        const p = partitionCanvas(mixed);
        expect(p.shapes).toHaveLength(ROWS.nodes.length);
        expect(p.bindings).toHaveLength(ROWS.edges.length);
        expect(p.freeform).toEqual([STICKY]);
    });
});

describe('an edge to an impossible endpoint is refused, not written', () => {
    it('throws with the refusal codes rather than writing a dangling row', () => {
        const g = rowsToTldraw(ROWS);
        // Re-point an end at a shape id that names no node — what a user does
        // by dragging an arrow end into empty space.
        g.bindings[0]!.toId = 'shape:does-not-exist';
        expect(() => tldrawToRows(g)).toThrow(EdgeEndpointError);
        try {
            tldrawToRows(g);
        } catch (e) {
            expect((e as EdgeEndpointError).refusals.map((r) => r.code)).toEqual([
                'UNKNOWN_NODE_KEY',
            ]);
        }
    });

    it('refuses an edge into a GROUP with the group-specific code', () => {
        // Reuses the editor's own validator, so a save cannot accept an edge
        // the canvas refused to draw. One rule, not two that drift.
        const g = rowsToTldraw(ROWS);
        g.bindings[0]!.toId = shapeIdForNodeKey('g1');
        try {
            tldrawToRows(g);
            throw new Error('expected a refusal');
        } catch (e) {
            expect(e).toBeInstanceOf(EdgeEndpointError);
            expect((e as EdgeEndpointError).refusals[0]!.code).toBe('NODE_IS_GROUP');
        }
    });

    it('a valid graph throws nothing — the control for the two above', () => {
        expect(() => tldrawToRows(rowsToTldraw(ROWS))).not.toThrow();
    });
});

describe("a DRAWN node's endpoint resolves through props, not the id", () => {
    it('an edge to a randomly-idded shape still finds its nodeKey', () => {
        // The spike this ports from stripped `shape:` off `fromId`. That is
        // right for a shape minted from a row and WRONG for one the user drew,
        // whose id is random — the strip would yield a key naming no node.
        const g = rowsToTldraw(ROWS);
        const drawnId = 'shape:V1StGXR8Z5jdHi6BMyT';
        g.shapes[1]!.id = drawnId;
        // EVERY binding that referenced the old id has to move with it — which
        // is the invariant tldraw's own store maintains, and which the first
        // version of this test forgot. Missing one left a dangling endpoint and
        // the serializer refused it, correctly; see the test below.
        g.bindings[0]!.toId = drawnId; // e1: n1 -> n2
        g.bindings[1]!.fromId = drawnId; // e2: n2 -> n1

        const out = tldrawToRows(g);
        // `n2` is what props say, regardless of the id it now carries.
        expect(out.edges[0]!.targetKey).toBe('n2');
        expect(out.edges[1]!.sourceKey).toBe('n2');
        expect(out.nodes[1]!.nodeKey).toBe('n2');
    });

    it('a binding left pointing at a REPLACED id is refused, not silently emptied', () => {
        // The case the test above tripped over by accident, kept because it is
        // the more dangerous one: a stale endpoint resolves to no key, and the
        // alternative to refusing it is writing an edge whose `sourceKey` is
        // the empty string — a dangling row the server would then have to
        // reject, after the user's work was already lost.
        const g = rowsToTldraw(ROWS);
        g.shapes[1]!.id = 'shape:renamed-and-not-rewired';
        expect(() => tldrawToRows(g)).toThrow(EdgeEndpointError);
    });
});
