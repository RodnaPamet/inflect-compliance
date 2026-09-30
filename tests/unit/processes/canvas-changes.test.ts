/**
 * Change classification — the knowledge a naive engine swap would lose.
 *
 * Three claims, each of which has already cost something or would:
 *
 *   1. **A node `replace` is substantive.** It used not to be, and label /
 *      subtitle / size / linked-entity edits were then *neither autosaved nor
 *      undoable* — while the inspector told the user "Click off the field or
 *      press Enter to save the edit." A fixed defect, asserted so the swap
 *      cannot reintroduce it.
 *
 *   2. **An edge `replace` is NOT substantive.** `handleEdgeUpdate` pushes
 *      history itself, so classifying it would push two undo entries for one
 *      edit. This is the asymmetry with (1), and before the adapter it was
 *      documented on the node side only — the edge predicate was a bare
 *      one-liner that happened to be right.
 *
 *   3. **A drag tick is transient; the mouse-up is not.** Marking every tick
 *      dirty autosaves continuously and buries a real undo point under twenty
 *      entries.
 *
 * The `dragging` check is `=== false` rather than falsy on purpose, and that has
 * its own test: the flag is optional, so an ABSENT one is not a commit and
 * `!c.dragging` would classify it as one.
 */
import {
    batchIsSubstantive,
    isSubstantive,
    type ClassifiedChange,
} from '@/lib/processes/canvas-changes';
import {
    classifyXyflowEdgeChange,
    classifyXyflowNodeChange,
} from '@/lib/processes/canvas-changes-xyflow';

// The unions are wide and only `type` (plus `dragging`) is read, so the fixtures
// are the minimum each branch inspects.
type NodeChangeLike = Parameters<typeof classifyXyflowNodeChange>[0];
type EdgeChangeLike = Parameters<typeof classifyXyflowEdgeChange>[0];
const node = (o: Record<string, unknown>) => o as unknown as NodeChangeLike;
const edge = (o: Record<string, unknown>) => o as unknown as EdgeChangeLike;

describe('node changes', () => {
    it.each([
        ['add', 'node-added'],
        ['remove', 'node-removed'],
    ])('%s is substantive', (type, kind) => {
        const c = classifyXyflowNodeChange(node({ type, id: 'n1' }));
        expect(c).toEqual({ significance: 'substantive', kind });
    });

    it('a REPLACE is substantive — the inspector-edit bug that was fixed once', () => {
        // Falling through to "not substantive" here meant inspector edits were
        // silently neither saved nor undoable.
        const c = classifyXyflowNodeChange(node({ type: 'replace', id: 'n1' }));
        expect(c.significance).toBe('substantive');
        expect(c.kind).toBe('node-data-replaced');
    });

    it('a committed drag is substantive; a tick in progress is not', () => {
        expect(
            classifyXyflowNodeChange(node({ type: 'position', id: 'n1', dragging: false })),
        ).toEqual({ significance: 'substantive', kind: 'node-moved-committed' });
        expect(
            classifyXyflowNodeChange(node({ type: 'position', id: 'n1', dragging: true })),
        ).toEqual({ significance: 'transient', kind: 'node-dragging' });
    });

    it('an ABSENT dragging flag is NOT a commit', () => {
        // `dragging` is optional. `!c.dragging` would read undefined as "not
        // dragging" and therefore as a commit — pushing an undo entry for an
        // event that committed nothing.
        expect(
            classifyXyflowNodeChange(node({ type: 'position', id: 'n1' })).significance,
        ).toBe('transient');
    });

    it.each([
        ['dimensions', 'node-measured'],
        ['select', 'node-selected'],
    ])('%s is transient', (type, kind) => {
        expect(classifyXyflowNodeChange(node({ type, id: 'n1' }))).toEqual({
            significance: 'transient',
            kind,
        });
    });

    it('an unrecognised variant fails toward doing NOTHING', () => {
        // An engine that adds a variant must not spray undo entries. The cost of
        // this default is a missed dirty flag, which the next real edit sets.
        expect(
            classifyXyflowNodeChange(node({ type: 'somethingNew', id: 'n1' })).significance,
        ).toBe('transient');
    });
});

describe('edge changes — asymmetric with nodes on `replace`', () => {
    it.each([
        ['add', 'edge-added'],
        ['remove', 'edge-removed'],
    ])('%s is substantive', (type, kind) => {
        expect(classifyXyflowEdgeChange(edge({ type, id: 'e1' }))).toEqual({
            significance: 'substantive',
            kind,
        });
    });

    it('a REPLACE is handled-by-caller, NOT substantive', () => {
        // `handleEdgeUpdate` pushes history and marks dirty itself. Classifying
        // this as substantive would push TWO undo entries for one edit.
        const c = classifyXyflowEdgeChange(edge({ type: 'replace', id: 'e1' }));
        expect(c.significance).toBe('handled-by-caller');
        expect(isSubstantive(c)).toBe(false);
    });

    it('and it is NOT transient either — the reason the third value exists', () => {
        // Transient would say something false: an edge data edit is a real edit.
        // Only its bookkeeping happens elsewhere.
        expect(
            classifyXyflowEdgeChange(edge({ type: 'replace', id: 'e1' })).significance,
        ).not.toBe('transient');
    });

    it('the node and edge paths DISAGREE on replace, deliberately', () => {
        // Stated as one assertion because the asymmetry is the invariant. If a
        // future change makes these agree, one of the two commit paths has
        // broken — either undo loses inspector edits, or it double-pushes.
        expect([
            classifyXyflowNodeChange(node({ type: 'replace', id: 'n1' })).significance,
            classifyXyflowEdgeChange(edge({ type: 'replace', id: 'e1' })).significance,
        ]).toEqual(['substantive', 'handled-by-caller']);
    });
});

describe('batchIsSubstantive', () => {
    const t: ClassifiedChange = { significance: 'transient', kind: 'x' };
    const s: ClassifiedChange = { significance: 'substantive', kind: 'y' };
    const h: ClassifiedChange = { significance: 'handled-by-caller', kind: 'z' };

    it('one substantive change among many transient ones counts', () => {
        expect(batchIsSubstantive([t, t, t, s, t])).toBe(true);
    });

    it('all-transient does not', () => {
        expect(batchIsSubstantive([t, t, t])).toBe(false);
    });

    it('handled-by-caller does NOT make a batch substantive', () => {
        // The whole point: the caller already pushed. Counting it here is the
        // double-push.
        expect(batchIsSubstantive([h, h])).toBe(false);
    });

    it('an EMPTY batch is not substantive — the vacuity case', () => {
        // An engine reporting no changes must not mark the document dirty.
        expect(batchIsSubstantive([])).toBe(false);
    });
});
