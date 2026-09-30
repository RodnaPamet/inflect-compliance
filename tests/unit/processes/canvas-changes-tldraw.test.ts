/**
 * The tldraw change mapper — what a store diff means.
 *
 * The xyflow mapper's tests assert a `switch` over an engine-supplied
 * discriminator. There is no discriminator here: tldraw reports
 * `updated: [from, to]` pairs, so every claim below is about a COMPARISON the
 * mapper performs, which is the part that can be wrong in ways a type cannot
 * catch.
 *
 * Three things are asserted that the xyflow side never had to be:
 *
 *   1. **A rewrite with no visible difference is not an edit.** tldraw writes
 *      records for reasons the product does not care about — a reorder, a
 *      rotation, a field touched by selection. If those counted, the canvas
 *      would be dirty from merely being looked at.
 *   2. **Geometry and props are told apart**, because the kinds are the only
 *      thing a reader of an autosave log has to go on.
 *   3. **The freeform layer counts.** A sticky note never becomes a row, but it
 *      IS persisted to `ProcessMap.freeformJson`, so adding one is an edit
 *      worth saving. Classifying it transient would silently lose annotation
 *      work — and the serializer's `partitionCanvas` draws exactly this line,
 *      so the two must agree.
 */
import {
    classifyTldrawDiff,
    type TldrawDiffLike,
    type TldrawRecordLike,
} from '@/lib/processes/canvas-changes-tldraw';
import { batchIsSubstantive } from '@/lib/processes/canvas-changes';
import { PROCESS_EDGE_BINDING_TYPE } from '@/components/processes/tldraw/process-edge-binding';
import { PROCESS_NODE_SHAPE_TYPE } from '@/components/processes/tldraw/process-node-shape';

const node = (over: Partial<TldrawRecordLike> = {}): TldrawRecordLike => ({
    typeName: 'shape',
    type: PROCESS_NODE_SHAPE_TYPE,
    x: 0,
    y: 0,
    props: { nodeKey: 'n1', label: 'A', subtitle: null, dataJson: null },
    ...over,
});

const binding = (over: Partial<TldrawRecordLike> = {}): TldrawRecordLike => ({
    typeName: 'binding',
    type: PROCESS_EDGE_BINDING_TYPE,
    props: { edgeKey: 'e1', edgeKind: 'flow' },
    ...over,
});

const sticky = (over: Partial<TldrawRecordLike> = {}): TldrawRecordLike => ({
    typeName: 'shape',
    type: 'note',
    x: 10,
    y: 10,
    props: { richText: 'a note' },
    ...over,
});

const empty: TldrawDiffLike = { added: {}, updated: {}, removed: {} };
const diff = (over: Partial<TldrawDiffLike>): TldrawDiffLike => ({ ...empty, ...over });

const kinds = (d: TldrawDiffLike) => classifyTldrawDiff(d).map((c) => c.kind);
const sig = (d: TldrawDiffLike) => classifyTldrawDiff(d).map((c) => c.significance);

describe('added and removed', () => {
    it('a node, an edge binding and a sticky are all edits worth saving', () => {
        const d = diff({
            added: { a: node(), b: binding(), c: sticky() },
        });
        expect(kinds(d).sort()).toEqual(['edge-added', 'freeform-added', 'node-added']);
        expect(sig(d)).toEqual(['substantive', 'substantive', 'substantive']);
    });

    it('removals mirror them', () => {
        const d = diff({ removed: { a: node(), b: binding(), c: sticky() } });
        expect(kinds(d).sort()).toEqual([
            'edge-removed',
            'freeform-removed',
            'node-removed',
        ]);
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(true);
    });

    it('a record type the mapper does not know does NOTHING', () => {
        // Defensive even though the host filters with `scope: 'document'`:
        // failing toward "do nothing" keeps an unrecognised record from
        // marking a document dirty. The cost is a missed dirty flag, which the
        // next real edit sets.
        const d = diff({
            added: { a: { typeName: 'camera', x: 5, y: 5 } },
            removed: { b: { typeName: 'instance' } },
        });
        expect(sig(d)).toEqual(['transient', 'transient']);
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(false);
    });
});

describe('updates — the kind has to be DERIVED', () => {
    it('a move is a move', () => {
        const d = diff({
            updated: { a: [node({ x: 0, y: 0 }), node({ x: 40, y: -12.5 })] },
        });
        expect(kinds(d)).toEqual(['node-moved']);
        expect(sig(d)).toEqual(['substantive']);
    });

    it('a label edit is a data replacement, not a move', () => {
        const d = diff({
            updated: {
                a: [
                    node({ props: { nodeKey: 'n1', label: 'A' } }),
                    node({ props: { nodeKey: 'n1', label: 'B' } }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['node-data-replaced']);
    });

    it('both at once is named as both, and is still one edit', () => {
        const d = diff({
            updated: {
                a: [
                    node({ x: 0, props: { label: 'A' } }),
                    node({ x: 99, props: { label: 'B' } }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['node-moved-and-replaced']);
        expect(sig(d)).toEqual(['substantive']);
    });

    it('a rewrite with NO visible difference is not an edit', () => {
        // The case with no xyflow equivalent, and the one that would make the
        // canvas permanently dirty. tldraw rewrites records for its own
        // reasons; only a difference the product can see counts.
        const before = node();
        const after = node({ ...before });
        const d = diff({ updated: { a: [before, after] } });
        expect(kinds(d)).toEqual(['node-untouched']);
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(false);
    });

    it('a rotation alone is not an edit either — it is not persisted', () => {
        // `rotation` is a tldraw shape field the serializer never reads, so a
        // change to it cannot reach a row. If this counted, rotating a node
        // would autosave a document that had not changed.
        const d = diff({
            updated: {
                a: [
                    { ...node(), rotation: 0 } as TldrawRecordLike,
                    { ...node(), rotation: 1.5 } as TldrawRecordLike,
                ],
            },
        });
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(false);
    });

    it('a RESIZE is not an edit, because a resize cannot be saved', () => {
        // The defect this file's prop comparison exists to prevent. `w` and `h`
        // are declared on the shape and read by NEITHER direction of the
        // serializer, so treating a resize as an edit would mark dirty →
        // autosave → a write that SUCCEEDS and bumps `version` → the size gone
        // on reload. A save that reports success and discards.
        //
        // `canResize(): false` on the shape util is the half a user meets
        // first; this is the half that holds if something reaches the props
        // another way (`editor.resizeShape()`, a future re-enable).
        const d = diff({
            updated: {
                a: [
                    node({ props: { nodeKey: 'n1', label: 'A', w: 220, h: 88 } }),
                    node({ props: { nodeKey: 'n1', label: 'A', w: 400, h: 200 } }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['node-untouched']);
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(false);
    });

    it('but a resize ALONGSIDE a real edit still counts', () => {
        // Teeth for the test above: ignoring `w`/`h` must not swallow a diff
        // that also changed something persisted.
        const d = diff({
            updated: {
                a: [
                    node({ props: { nodeKey: 'n1', label: 'A', w: 220 } }),
                    node({ props: { nodeKey: 'n1', label: 'B', w: 400 } }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['node-data-replaced']);
    });

    it('re-attaching an edge END is an edit — it changes fromId, not a prop', () => {
        // The mirror of the resize case, and a bug in this file's first draft.
        // The projection reads `b.fromId` / `b.toId`; `props.sourceKey` is, in
        // the serializer's own words, "a denormalised convenience that goes
        // stale the moment one moves". So a comparison looking only at props
        // read a re-attachment as `edge-untouched` — a persisted change that
        // would never have been saved.
        const d = diff({
            updated: {
                a: [
                    binding({ fromId: 'shape:n1', toId: 'shape:n2' }),
                    binding({ fromId: 'shape:n3', toId: 'shape:n2' }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['edge-reattached']);
        expect(sig(d)).toEqual(['substantive']);
    });

    it("an edge binding's data edit counts — nothing else pushes for it here", () => {
        // The divergence from the xyflow mapper worth knowing. There,
        // `handleEdgeUpdate` pushes history itself, so an edge `replace` is
        // `handled-by-caller`. On tldraw no caller pushes, the editor does, so
        // an edge edit is simply substantive.
        const d = diff({
            updated: {
                a: [
                    binding({ props: { edgeKey: 'e1', edgeKind: 'flow' } }),
                    binding({ props: { edgeKey: 'e1', edgeKind: 'exception' } }),
                ],
            },
        });
        expect(kinds(d)).toEqual(['edge-data-replaced']);
        expect(sig(d)).toEqual(['substantive']);
    });
});

describe('the whole diff answers the host in one question', () => {
    it('one real edit among a crowd of no-ops counts', () => {
        const d = diff({
            updated: {
                a: [node(), node()],
                b: [node({ x: 1 }), node({ x: 2 })],
                c: [sticky(), sticky()],
            },
        });
        expect(batchIsSubstantive(classifyTldrawDiff(d))).toBe(true);
    });

    it('an empty diff is not substantive — the vacuity case', () => {
        expect(classifyTldrawDiff(empty)).toEqual([]);
        expect(batchIsSubstantive(classifyTldrawDiff(empty))).toBe(false);
    });
});
