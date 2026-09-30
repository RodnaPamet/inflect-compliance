/**
 * The serializer's output is accepted by the schema the SERVER applies.
 *
 * ── The gap this closes ──────────────────────────────────────────────
 *
 * `serializer-round-trip.test.ts` asserts `tldrawToRows(rowsToTldraw(ROWS))`
 * equals `ROWS` — **self-consistency against a fixture the test authored**.
 * Every `tldrawToRows` reference under `tests/` lived in that one file and none
 * of them called `SaveProcessMapSchema.parse`. Round-trip identity proves the
 * serializer is reversible; it says nothing about whether its output is
 * **wire-valid**.
 *
 * That distinction is the whole cutover risk. #2961 says *"the backend does not
 * change at all"*, which is true and settles the **server** — not the **seam**:
 * `tldrawToRows` is a NEW producer feeding an UNCHANGED
 * `SaveProcessMapSchema`. A field the serializer emits as `undefined` where the
 * schema wants a string, or a shape it widens, is a 400 at save time on a
 * canvas that passed every existing test.
 *
 * Same shape as two other defects found while preparing this migration: the
 * oracle was a fixture the test controlled rather than the thing production
 * reads.
 *
 * ── Measured: this is NOT redundant with the round-trip test ─────────
 *
 * The two are orthogonal, and the mutation matrix says so rather than the
 * prose:
 *
 *   | change to the serializer      | round-trip | wire-validity |
 *   |-------------------------------|------------|---------------|
 *   | `edgeKind` → undefined        | **fails**  | passes        |
 *   | `controlId` → ''              | fails      | **fails**     |
 *   | `posX` → a string             | fails      | **fails**     |
 *   | a 300-char label, passed faithfully | passes | **fails**  |
 *
 * The first row is wire-validity's blind spot and is correct behaviour:
 * `edgeKind` is `.default('flow')`, so an omitted one is a VALID payload — it
 * would just silently turn an `exception` edge into a `flow` one, which only
 * identity can see.
 *
 * The last row is why this file exists. Identity held (measured: `true`) and
 * the server refused the save — so a serializer that is perfectly faithful can
 * still produce a payload the API rejects, and no round-trip assertion can
 * notice.
 *
 * ── Why the negative control is not optional here ────────────────────
 *
 * `safeParse` returns an object either way. A miswired assertion — reading
 * `.success` off the wrong thing, or parsing `{}` — passes silently and looks
 * exactly like a green seam. So the last test feeds the schema something it
 * MUST reject, and the whole file is only evidence because that one fails
 * when it should.
 *
 * ── What is deliberately NOT asserted ────────────────────────────────
 *
 * The serializer does not enforce the schema's 200-character bounds on
 * `label` / `subtitle` / `labelOverride`, so a 300-character label passes
 * through and the server refuses the save. That is **pre-existing** — neither
 * `ProcessInspector` nor `processNodeShapeProps` bounds those fields today, so
 * a user can already do it on the live canvas — and the fix is client-side
 * enforcement (#2961 build item 5), not a test here restating the schema.
 * Recorded rather than asserted, so this file does not cement the current
 * behaviour as intended.
 */
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';
import {
    rowsToTldraw,
    tldrawToRows,
    type GraphRows,
} from '@/components/processes/tldraw/serializer';

/**
 * Every field the wire schema declares, populated — including the ones least
 * likely to appear in a fixture.
 *
 * A group with a child (`parentNodeKey`), fractional and negative coordinates,
 * `dataJson` both null and populated, a nullable `subtitle` and
 * `labelOverride` resolved both ways, and an edge carrying a control — whose
 * `controlId` the schema requires `min(1)` because the column is NOT NULL with
 * an FK.
 */
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

/** The save payload shape, as the route receives it. */
const payload = (rows: GraphRows) => ({ nodes: rows.nodes, edges: rows.edges });

function issuesOf(rows: GraphRows): string[] {
    const r = SaveProcessMapSchema.safeParse(payload(rows));
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('rows the serializer produces satisfy the wire schema', () => {
    it('the load → edit → save path validates, whole payload', () => {
        // This is the actual cutover path: rows arrive from the repository,
        // become a canvas, and come back as rows to be saved.
        const out = tldrawToRows(rowsToTldraw(ROWS));

        // Asserting the ISSUE LIST rather than a boolean, so a failure names
        // the offending field instead of saying only `false !== true`.
        expect(issuesOf(out)).toEqual([]);
    });

    it('stays valid across repeated cycles, where a drift would compound', () => {
        let graph = rowsToTldraw(ROWS);
        for (let i = 0; i < 5; i++) {
            graph = rowsToTldraw(tldrawToRows(graph), graph.freeform);
        }
        expect(issuesOf(tldrawToRows(graph))).toEqual([]);
    });

    it('an empty graph is a valid payload — clearing a map is a legal save', () => {
        expect(issuesOf(tldrawToRows(rowsToTldraw({ nodes: [], edges: [] })))).toEqual([]);
    });

    it('the freeform layer validates alongside the rows', () => {
        // `freeformJson` is optional so an omitting client leaves the stored
        // value alone; an explicit null is how a caller erases it. Both are
        // legal and the serializer's rows must not interfere with either.
        const out = tldrawToRows(rowsToTldraw(ROWS));
        for (const freeformJson of [undefined, null, [{ id: 'shape:s1', type: 'note' }]]) {
            const r = SaveProcessMapSchema.safeParse({ ...payload(out), freeformJson });
            expect({ freeformJson, success: r.success }).toEqual({
                freeformJson,
                success: true,
            });
        }
    });
});

describe('and the check can fail', () => {
    it('rejects a payload the server would refuse', () => {
        // Without this the file is not evidence: `safeParse` returns an object
        // either way, so a miswired assertion would pass on everything and
        // look identical to a green seam.
        //
        // `nodeKey` is `z.string().min(1)`, so an empty one is refused — a
        // defect the serializer cannot currently produce, which is exactly why
        // it is safe to use as the control.
        const broken: GraphRows = {
            ...ROWS,
            nodes: [{ ...ROWS.nodes[0]!, nodeKey: '' }, ...ROWS.nodes.slice(1)],
        };
        const issues = issuesOf(broken);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.join(' | ')).toMatch(/nodes\.0\.nodeKey/);
    });
});
