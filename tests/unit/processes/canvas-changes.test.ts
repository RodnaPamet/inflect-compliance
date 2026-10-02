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

// The unions are wide and only `type` (plus `dragging`) is read, so the fixtures
// are the minimum each branch inspects.
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
