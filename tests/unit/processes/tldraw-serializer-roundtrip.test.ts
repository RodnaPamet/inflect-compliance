/**
 * SPIKE ONLY — #2959 §D.3. The verdict test for the whole migration.
 *
 * "rowsToTldraw(tldrawToRows(store)) is STABLE — a load/save cycle with no user
 * edit produces an identical row set."
 *
 * Measured in the direction that actually matters: ROWS -> tldraw -> ROWS. That
 * is the cycle a save performs. The other direction is interesting; this is the
 * one that writes to the database.
 *
 * CONTROLS ARE IN THE COMPARISON on purpose. `ProcessEdgeInputSchema.controls`
 * defaults to `[]` and the repository recreates `ProcessEdgeControl` rows only
 * from the payload, so a projection that dropped them would validate, save
 * cleanly, and silently delete every edge->control link — while a round-trip
 * that also ignored them agreed at both ends. The check that cannot see its
 * worst failure is worse than no check.
 */
import {
    rowsToTldraw,
    tldrawToRows,
    shapeIdFor,
    nodeKeyFor,
    isProcessShape,
    UnknownNodeKeyError,
    type GraphRows,
    type FreeformShape,
} from '@/lib/processes/tldraw-spike/serializer';
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';

/**
 * A graph exercising every optional field in both states.
 *
 * Parsed through the REAL schema first, so these are the rows a save actually
 * stores rather than the rows a client happened to send. That distinction has
 * teeth: the schema applies defaults (`edgeKind` -> 'flow', `controls` -> []),
 * so an unparsed fixture would round-trip to something MORE populated than it
 * started and fail for a reason that says nothing about the serializer.
 */
function representativeRows(): GraphRows {
    const parsed = SaveProcessMapSchema.parse({
        nodes: [
            {
                nodeKey: 'n1',
                nodeType: 'processStep',
                label: 'Collect payroll input',
                subtitle: 'monthly',
                posX: 10.5,
                posY: -20.25,
                parentNodeKey: null,
                dataJson: { owner: 'finance', severity: 3 },
            },
            {
                // every optional at its other setting
                nodeKey: 'n2',
                nodeType: 'group',
                label: 'Payroll',
                posX: 0,
                posY: 0,
            },
            {
                nodeKey: 'n3',
                nodeType: 'processStep',
                label: 'Approve',
                subtitle: null,
                posX: 300,
                posY: 120,
                parentNodeKey: 'n2',
                dataJson: null,
            },
        ],
        edges: [
            {
                edgeKey: 'e1',
                sourceKey: 'n1',
                targetKey: 'n3',
                edgeKind: 'flow',
                labelOverride: 'submits',
                dataJson: { note: 'x' },
                controls: [
                    { controlKey: 'c1', label: 'Segregation of duties', controlId: 'ctl_1', dataJson: null },
                    { controlKey: 'c2', label: 'Four-eyes approval', controlId: 'ctl_2', dataJson: { k: 1 } },
                ],
            },
            {
                // no labelOverride, no dataJson, no controls — schema defaults apply
                edgeKey: 'e2',
                sourceKey: 'n3',
                targetKey: 'n1',
            },
        ],
    });
    return { nodes: parsed.nodes, edges: parsed.edges };
}

/**
 * The rows AS THE DATABASE STORES THEM.
 *
 * ═══ THE DISTINCTION §D.3 HAS TO MAKE, AND CURRENTLY DOES NOT ═══
 *
 * The prompt says a cycle must produce "an identical row set". Two readings:
 *
 *   payload-identical — the object handed to the save is byte-for-byte what
 *                       came out of the previous load;
 *   row-identical     — what lands in Postgres is unchanged.
 *
 * They differ, and only the second matters. `ProcessNodeInputSchema` leaves an
 * omitted `subtitle` / `parentNodeKey` / `dataJson` as `undefined`; the
 * serializer materialises them as `null`. So the payloads are NOT equal.
 *
 * The rows are. `ProcessMapRepository` writes `n.subtitle ?? null`,
 * `n.parentNodeKey ?? null`, and `dataJson === undefined ? JsonNull : … ??
 * JsonNull` — `undefined` and `null` both become SQL NULL. Same for the edge's
 * `labelOverride` and `dataJson`.
 *
 * So this mirrors the repository's own coercion and compares what is stored.
 * Comparing raw payloads instead would report drift on every save that touched
 * an optional field — a red test describing a difference the database cannot
 * represent.
 */
function asStored(rows: GraphRows): GraphRows {
    return {
        nodes: rows.nodes.map((n) => ({
            ...n,
            subtitle: n.subtitle ?? null,
            parentNodeKey: n.parentNodeKey ?? null,
            dataJson: n.dataJson ?? null,
        })),
        edges: rows.edges.map((e) => ({
            ...e,
            labelOverride: e.labelOverride ?? null,
            dataJson: e.dataJson ?? null,
            controls: e.controls ?? [],
        })),
    };
}

describe('§D.3 — the serializer round-trip', () => {
    it('rows -> tldraw -> rows is EXACT at the row level', () => {
        const rows = representativeRows();
        expect(tldrawToRows(rowsToTldraw(rows))).toEqual(asStored(rows));
    });

    it('...and the ONLY difference from the raw payload is undefined vs null', () => {
        // Pinned so nobody later "fixes" the serializer to emit `undefined` and
        // calls it a stability improvement. It would change nothing in the
        // database and would make the projection lossy in the other direction:
        // a shape prop that is absent is not the same as one set to null once a
        // real tldraw store is holding it.
        const rows = representativeRows();
        const back = tldrawToRows(rowsToTldraw(rows));

        // Payload-level: NOT equal, and that is expected.
        expect(back).not.toEqual(rows);

        // Row-level: equal. The four fields below are the entire delta.
        expect(rows.nodes[1].subtitle).toBeUndefined();
        expect(back.nodes[1].subtitle).toBeNull();
        expect(rows.edges[1].labelOverride).toBeUndefined();
        expect(back.edges[1].labelOverride).toBeNull();
        // And the repository stores both as SQL NULL, which is why this is a
        // difference the database cannot represent.
        expect(asStored(rows)).toEqual(back);
    });

    it('and stays exact over repeated cycles — autosave runs this constantly', () => {
        // One clean cycle proves the projection is not lossy. It does not prove
        // it is not DRIFTING: a transform that normalises on the way out would
        // pass once and diverge on the second pass, which is precisely the
        // "spurious versions forever" failure the phase is guarding against.
        const rows = representativeRows();
        let cur = rows;
        for (let i = 0; i < 5; i++) cur = tldrawToRows(rowsToTldraw(cur));
        expect(cur).toEqual(asStored(rows));
        // The second cycle must equal the first — drift, not loss, is what
        // writes spurious versions forever.
        expect(cur).toEqual(tldrawToRows(rowsToTldraw(rows)));
    });

    it('carries edge CONTROLS through — the failure the comparison must be able to see', () => {
        const rows = representativeRows();
        const back = tldrawToRows(rowsToTldraw(rows));
        expect(back.edges[0].controls).toEqual(rows.edges[0].controls);
        expect(back.edges[0].controls).toHaveLength(2);
        // The positive control for the assertion above: an empty controls array
        // must survive as empty, not become undefined — the shape a dropped
        // projection produces.
        expect(back.edges[1].controls).toEqual([]);
    });

    it('the comparison can actually fail — a corrupted graph is NOT equal', () => {
        // Without this, `toEqual` on a projection that returned its input
        // unchanged would pass every assertion above forever.
        const rows = representativeRows();
        const mangled = rowsToTldraw(rows);
        mangled.shapes[0].props.label = 'changed';
        expect(tldrawToRows(mangled)).not.toEqual(asStored(rows));
    });

    it('shape ids derive from nodeKey and reverse exactly', () => {
        for (const key of ['n1', 'node-with-dash', 'n_42']) {
            expect(nodeKeyFor(shapeIdFor(key))).toBe(key);
        }
        // Deterministic across calls — the property the whole scheme rests on.
        expect(shapeIdFor('n1')).toBe(shapeIdFor('n1'));
    });

    it('position is read from the SHAPE, so a drag is not discarded', () => {
        // tldraw updates x/y when a user moves a node and touches nothing else.
        // A projection reading position from props would lose every move while
        // round-tripping perfectly on an untouched graph.
        const rows = representativeRows();
        const graph = rowsToTldraw(rows);
        graph.shapes[0].x = 999;
        graph.shapes[0].y = -1;
        const back = tldrawToRows(graph);
        expect([back.nodes[0].posX, back.nodes[0].posY]).toEqual([999, -1]);
    });

    it('edge endpoints are read from the BINDING, so re-attaching an arrow is not discarded', () => {
        // Same class as the drag case: `props.sourceKey` is a denormalised copy
        // and goes stale the moment a user moves an endpoint.
        const rows = representativeRows();
        const graph = rowsToTldraw(rows);
        graph.bindings[0].toId = shapeIdFor('n2');
        expect(tldrawToRows(graph).edges[0].targetKey).toBe('n2');
    });
});

/**
 * §2 — "ALLOW FREEFORM, BUT KEEP IT SEPARATE"
 *
 * tldraw's native shapes are a reason to switch, and the product should let
 * people use them. But they are NOT process nodes and must never become
 * `ProcessNode` rows — the structured graph has to stay exactly as queryable as
 * it is today, and a sticky note must never appear in a coverage report.
 *
 * That property is one `.filter()` away from being lost, and losing it fails
 * QUIETLY: the canvas looks right, the save succeeds, and a coverage figure
 * silently counts somebody's annotation as a process step.
 */
describe('freeform shapes never become process rows', () => {
    const sticky: FreeformShape = { id: 'shape:sticky-1', type: 'note', x: 5, y: 5, text: 'ask Dana' };
    const drawing: FreeformShape = { id: 'shape:draw-1', type: 'draw', x: 0, y: 0 };

    it('a sticky note on the canvas produces no node row', () => {
        const rows = representativeRows();
        const graph = rowsToTldraw(rows, [sticky, drawing]);

        // The store hands back everything on the canvas, so simulate that:
        // freeform shapes sitting in the same array as the process ones.
        const mixed = {
            ...graph,
            shapes: [...graph.shapes, sticky as never, drawing as never],
        };

        const back = tldrawToRows(mixed);
        expect(back.nodes).toHaveLength(rows.nodes.length);
        expect(back.nodes.map((n) => n.nodeKey)).toEqual(['n1', 'n2', 'n3']);
        expect(back.nodes.some((n) => n.label === 'ask Dana')).toBe(false);
    });

    it('the discriminator can actually tell them apart — the control', () => {
        // If `isProcessShape` returned true for everything the assertion above
        // would still pass on a graph with no freeform shapes in it, and fail
        // only in production.
        expect(isProcessShape({ type: 'process-node' })).toBe(true);
        expect(isProcessShape(sticky)).toBe(false);
        expect(isProcessShape(drawing)).toBe(false);
    });

    it('freeform shapes survive the projection in their own compartment', () => {
        // Separate does not mean discarded. They must come back, or the first
        // save after someone adds a sticky note deletes it.
        const graph = rowsToTldraw(representativeRows(), [sticky, drawing]);
        expect(graph.freeform).toEqual([sticky, drawing]);
    });
});

/**
 * §2.4 — an edge referencing an unknown nodeKey is refused CLIENT-SIDE, with
 * the same meaning as the server's refusal.
 *
 * The repository already rejects this. The point of doing it here is WHEN: the
 * user finds out at draw time rather than after ten minutes of work, when the
 * save comes back 400 and the canvas cannot say which arrow caused it.
 */
describe('an edge to a node that is not there is refused', () => {
    it('throws, and names the edge and the missing key', () => {
        const graph = rowsToTldraw(representativeRows());
        graph.bindings[0].toId = shapeIdFor('does-not-exist');

        expect(() => tldrawToRows(graph)).toThrow(UnknownNodeKeyError);
        expect(() => tldrawToRows(graph)).toThrow(/e1/);
        expect(() => tldrawToRows(graph)).toThrow(/does-not-exist/);
    });

    it('names BOTH ends when both are missing, not just the first', () => {
        // A message that stops at the first problem sends the user round the
        // loop once per broken endpoint.
        const graph = rowsToTldraw(representativeRows());
        graph.bindings[0].fromId = shapeIdFor('ghost-a');
        graph.bindings[0].toId = shapeIdFor('ghost-b');
        expect(() => tldrawToRows(graph)).toThrow(/ghost-a, ghost-b/);
    });

    it('a well-formed graph does NOT throw — the control', () => {
        // Without this, a validator that threw unconditionally would satisfy
        // every assertion above.
        expect(() => tldrawToRows(rowsToTldraw(representativeRows()))).not.toThrow();
    });

    it('a freeform shape does not satisfy an edge endpoint', () => {
        // The two rules interact: if the integrity check counted ALL shapes as
        // possible endpoints, an arrow drawn to a sticky note would validate
        // and then save an edge pointing at a node that does not exist.
        const rows = representativeRows();
        const graph = rowsToTldraw(rows, []);
        const sticky = { id: shapeIdFor('sticky-1'), type: 'note' } as never;
        graph.shapes.push(sticky);
        graph.bindings[0].toId = shapeIdFor('sticky-1');
        expect(() => tldrawToRows(graph)).toThrow(/sticky-1/);
    });
});
