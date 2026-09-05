/**
 * The proposal-diff decision table, exercised directly.
 *
 * `computeProposalDiff` is pure so that every branch a reviewer can land on -
 * including the two a live database makes awkward to reach, a deleted target
 * and a corrupt payload - is reachable without fixtures. The rendered test
 * proves the UI honours the statuses; this file proves the statuses are right.
 *
 * The two properties worth stating plainly, because they are what stop the
 * review gate degrading into a checkbox:
 *
 *   1. `NO_CHANGES` is a computed ANSWER and is reviewable. The two refusals
 *      are the absence of an answer and are not. Collapsing them would let a
 *      reviewer approve a change nobody rendered.
 *   2. `baseDigest` is a function of the BASE the reviewer read. If it were
 *      constant, or a function of the payload, the approve-time freshness check
 *      would pass over a record that had moved - which is the "diff against a
 *      stale base" failure wearing a green tick.
 */
import {
    computeProposalDiff,
    computeDiffBaseDigest,
    isDiffReviewable,
    renderDiffValue,
} from '@/lib/agentic/proposal-diff';

describe('CREATE renders the whole payload as additions', () => {
    it('lists every key with no before value, sorted', () => {
        const diff = computeProposalDiff({
            operation: 'CREATE',
            payloadJson: JSON.stringify({ title: 'T', impact: 3 }),
        });

        expect(diff.status).toBe('CREATE');
        expect(diff.fields.map((f) => f.field)).toStrictEqual(['impact', 'title']);
        expect(diff.fields.every((f) => f.before === null && f.changed)).toBe(true);
        // No base exists, so there is nothing to fingerprint and nothing for the
        // approve path to demand back.
        expect(diff.baseDigest).toBeNull();
    });
});

describe('UPDATE compares the payload against the base it was given', () => {
    it('marks only the fields whose rendered value differs', () => {
        const diff = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ title: 'Same', likelihood: 9 }),
            target: { title: 'Same', likelihood: 4, untouched: 'ignored' },
        });

        expect(diff.status).toBe('UPDATE');
        const byField = Object.fromEntries(diff.fields.map((f) => [f.field, f]));
        expect(byField.likelihood).toStrictEqual({
            field: 'likelihood',
            before: '4',
            after: '9',
            changed: true,
        });
        expect(byField.title.changed).toBe(false);
        // A column the payload never mentions is not part of the proposal and
        // must not appear as an untouched row - it would pad the diff with
        // noise, and a noisy diff is one reviewers stop reading.
        expect(byField.untouched).toBeUndefined();
        expect(diff.comparedFieldCount).toBe(2);
    });

    it('reports NO_CHANGES when the base already says what the payload proposes', () => {
        const diff = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ name: 'Quarterly access review' }),
            target: { name: 'Quarterly access review' },
        });

        expect(diff.status).toBe('NO_CHANGES');
        expect(diff.fields).toHaveLength(1);
        // Still a computed answer, so it still carries a base fingerprint.
        // Whether that makes it APPROVABLE is asserted once, exhaustively, in
        // the `isDiffReviewable` table below - repeating it here would make two
        // tests fail for one defect and neither of them the sole detector.
        expect(diff.baseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
});

describe('the two ways a diff can fail to exist', () => {
    it('refuses an UPDATE whose target could not be read', () => {
        const diff = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ severity: 'HIGH' }),
            target: null,
        });

        expect(diff.status).toBe('TARGET_MISSING');
        // Nothing was compared, and the field rows carry no before values - a
        // blank before-column would read as "currently empty", which is a claim
        // about a record we could not read.
        expect(diff.comparedFieldCount).toBe(0);
        expect(diff.fields.every((f) => f.before === null && !f.changed)).toBe(true);
        expect(diff.baseDigest).toBeNull();
    });

    it('refuses a payload that is not an object', () => {
        for (const payloadJson of ['not json', '"a string"', '[1,2,3]', 'null']) {
            const diff = computeProposalDiff({ operation: 'CREATE', payloadJson });
            expect(diff.status).toBe('PAYLOAD_UNREADABLE');
            expect(diff.fields).toStrictEqual([]);
        }
    });
});

describe('isDiffReviewable draws the line at "was an answer computed"', () => {
    it('admits the three computed statuses and no others', () => {
        expect(isDiffReviewable({ status: 'CREATE' })).toBe(true);
        expect(isDiffReviewable({ status: 'UPDATE' })).toBe(true);
        expect(isDiffReviewable({ status: 'NO_CHANGES' })).toBe(true);
        expect(isDiffReviewable({ status: 'TARGET_MISSING' })).toBe(false);
        expect(isDiffReviewable({ status: 'PAYLOAD_UNREADABLE' })).toBe(false);
    });
});

describe('baseDigest fingerprints the base, not the proposal', () => {
    it('moves when the record moves, holds when only the payload changes, and separates absent from empty', () => {
        const base = { title: 'A', likelihood: 4 };
        const first = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ title: 'A', likelihood: 9 }),
            target: base,
        });
        // Same base, a DIFFERENT proposal over the same two fields: the
        // reviewer read the same before-column, so the fingerprint is the same.
        const sameBaseOtherPayload = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ title: 'A', likelihood: 7 }),
            target: base,
        });
        // The record moved underneath: the fingerprint must not survive it, or
        // the approve-time check would wave through a stale diff.
        const movedBase = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ title: 'A', likelihood: 9 }),
            target: { title: 'A', likelihood: 5 },
        });

        expect(first.baseDigest).toBe(sameBaseOtherPayload.baseDigest);
        expect(first.baseDigest).not.toBe(movedBase.baseDigest);

        // The third case belongs in the SAME test, because all three are the one
        // property "the fingerprint is a function of the before-column, and of
        // nothing else". Split across two tests, every mutation of the digest
        // failed both and neither was the sole detector of anything.
        //
        // An absent field and one whose value is the empty string both render
        // as something, and a naive join collapses them - so a record whose
        // owner was cleared to '' would share a fingerprint with one whose owner
        // was never in the diff at all.
        const absent = computeDiffBaseDigest([
            { field: 'owner', before: null, after: 'x', changed: true },
        ]);
        const emptyString = computeDiffBaseDigest([
            { field: 'owner', before: '', after: 'x', changed: true },
        ]);
        expect(absent).not.toBe(emptyString);
    });
});

describe('values are rendered the way a reviewer compares them', () => {
    it('collapses null and undefined, and orders object keys stably', () => {
        expect(renderDiffValue(null)).toBeNull();
        expect(renderDiffValue(undefined)).toBeNull();
        expect(renderDiffValue(4)).toBe('4');
        expect(renderDiffValue(false)).toBe('false');
        expect(renderDiffValue('text')).toBe('text');
        // Key order is not a change. A diff that reports one cries wolf, and a
        // queue whose diffs cry wolf is a queue that gets rubber-stamped.
        expect(renderDiffValue({ b: 1, a: 2 })).toBe(renderDiffValue({ a: 2, b: 1 }));
        // Array order IS a change - the reviewer would see a different list.
        expect(renderDiffValue([1, 2])).not.toBe(renderDiffValue([2, 1]));
    });
});
