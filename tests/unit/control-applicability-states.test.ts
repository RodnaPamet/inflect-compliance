/**
 * The three-state applicability model — display and predicate, over the SAME
 * row matrix.
 *
 * The Controls page used to show three states while the server filtered a
 * two-value column, so the page stripped `applicability` from its API query
 * and re-filtered in the browser. Two consequences: the facet only saw the
 * loaded page, and a hard nav (where the SSR read DID pass the param through)
 * returned different rows than a client nav for the same URL.
 *
 * The fix is that `applicabilityState` (what a cell shows) and
 * `applicabilityStateWhere` (what SQL selects) come from one file. These
 * tests are what makes that claim hold: every assertion runs the predicate
 * against rows the display function has already classified, so a change to
 * one that does not match the other fails here rather than in production.
 */
import {
    APPLICABILITY_STATES,
    applicabilityState,
    applicabilityStateWhere,
    isApplicabilityState,
    type ApplicabilityState,
} from '@/lib/controls/control-applicability';

/** Every meaningful combination of the two columns the derivation reads. */
const ROWS = [
    { id: 'na-undecided', applicability: 'NOT_APPLICABLE', applicabilityDecidedAt: null },
    { id: 'na-decided', applicability: 'NOT_APPLICABLE', applicabilityDecidedAt: '2026-01-01T00:00:00Z' },
    { id: 'applicable-decided', applicability: 'APPLICABLE', applicabilityDecidedAt: '2026-01-01T00:00:00Z' },
    { id: 'applicable-undecided', applicability: 'APPLICABLE', applicabilityDecidedAt: null },
    { id: 'applicable-absent-field', applicability: 'APPLICABLE' },
] as const;

/**
 * Evaluate the predicate the way Postgres would, so the two halves can be
 * compared on identical inputs. Handles exactly the shapes
 * `applicabilityStateWhere` can produce — a stricter reader than Prisma, on
 * purpose: an unexpected shape throws instead of quietly matching nothing.
 */
type Leaf = { applicability?: unknown; applicabilityDecidedAt?: unknown };
function matches(where: unknown, row: { applicability: string; applicabilityDecidedAt?: string | null }): boolean {
    if (where === undefined) return true;
    const node = where as Leaf & { OR?: unknown[] };
    if (node.OR) return node.OR.some((branch) => matches(branch, row));

    if (node.applicability !== undefined) {
        const cond = node.applicability;
        if (typeof cond === 'string') {
            if (row.applicability !== cond) return false;
        } else if (cond && typeof cond === 'object' && 'not' in cond) {
            if (row.applicability === (cond as { not: string }).not) return false;
        } else {
            throw new Error(`unexpected applicability predicate: ${JSON.stringify(cond)}`);
        }
    }

    if ('applicabilityDecidedAt' in node) {
        const cond = node.applicabilityDecidedAt;
        const decided = row.applicabilityDecidedAt ?? null;
        if (cond === null) {
            if (decided !== null) return false;
        } else if (cond && typeof cond === 'object' && (cond as { not?: unknown }).not === null) {
            if (decided === null) return false;
        } else {
            throw new Error(`unexpected decidedAt predicate: ${JSON.stringify(cond)}`);
        }
    }

    return true;
}

describe('applicabilityState — what the column shows', () => {
    it('classifies every row shape', () => {
        expect(ROWS.map((r) => ({ id: r.id, state: applicabilityState(r) }))).toEqual([
            { id: 'na-undecided', state: 'NOT_APPLICABLE' },
            // N/A wins regardless of the timestamp — the first branch does not
            // look at `applicabilityDecidedAt` at all.
            { id: 'na-decided', state: 'NOT_APPLICABLE' },
            { id: 'applicable-decided', state: 'APPLICABLE' },
            // The distinction the two-value enum cannot express: stored
            // APPLICABLE, but nobody ever assessed it.
            { id: 'applicable-undecided', state: 'UNASSESSED' },
            { id: 'applicable-absent-field', state: 'UNASSESSED' },
        ]);
    });

    it('accepts a Date as well as an ISO string', () => {
        // Server rows carry `Date`; wire rows carry a string. Both must land
        // on APPLICABLE, or SSR and client paint different badges.
        expect(
            applicabilityState({ applicability: 'APPLICABLE', applicabilityDecidedAt: new Date() }),
        ).toBe('APPLICABLE');
    });
});

describe('applicabilityStateWhere — what SQL selects', () => {
    it.each(APPLICABILITY_STATES)('single state %s selects exactly the rows that display it', (state) => {
        const where = applicabilityStateWhere([state]);
        const selected = ROWS.filter((r) => matches(where, r)).map((r) => r.id);
        const displayed = ROWS.filter((r) => applicabilityState(r) === state).map((r) => r.id);
        expect(selected).toEqual(displayed);
    });

    it('a multi-select selects the union', () => {
        const states: ApplicabilityState[] = ['NOT_APPLICABLE', 'UNASSESSED'];
        const where = applicabilityStateWhere(states);
        const selected = ROWS.filter((r) => matches(where, r)).map((r) => r.id);
        expect(selected).toEqual(['na-undecided', 'na-decided', 'applicable-undecided', 'applicable-absent-field']);
        // The complement is exactly the rows displaying the unpicked state.
        expect(ROWS.filter((r) => !matches(where, r)).map((r) => r.id)).toEqual(['applicable-decided']);
    });

    it('no states selected means no restriction', () => {
        expect(applicabilityStateWhere([])).toBeUndefined();
    });

    it('all three selected means no restriction — not a three-branch OR', () => {
        // Picking everything is the same as picking nothing; emitting the OR
        // anyway would make the planner unpick a predicate that excludes no
        // row.
        expect(applicabilityStateWhere([...APPLICABILITY_STATES])).toBeUndefined();
    });

    it('dedupes a repeated state', () => {
        expect(applicabilityStateWhere(['APPLICABLE', 'APPLICABLE'])).toEqual(
            applicabilityStateWhere(['APPLICABLE']),
        );
    });

    it('a single state does not wrap itself in OR', () => {
        // Keeps the common case a plain conjunct the index can serve.
        expect(applicabilityStateWhere(['NOT_APPLICABLE'])).not.toHaveProperty('OR');
    });

    it('never filters on applicability alone for the two applicable states', () => {
        // The bug this replaced: `where.applicability = 'APPLICABLE'` cannot
        // separate assessed from unassessed, because both are stored the same
        // way. Both predicates must consult the timestamp.
        for (const state of ['APPLICABLE', 'UNASSESSED'] as const) {
            expect(applicabilityStateWhere([state])).toHaveProperty('applicabilityDecidedAt');
        }
    });
});

describe('display and predicate agree', () => {
    it('for every single-state selection, over every row', () => {
        // The invariant stated directly: selecting state S returns exactly the
        // rows whose cell reads S. This is the assertion the client-side
        // re-filter was standing in for.
        for (const state of APPLICABILITY_STATES) {
            const where = applicabilityStateWhere([state]);
            for (const row of ROWS) {
                expect({ row: row.id, state, selected: matches(where, row) }).toEqual({
                    row: row.id,
                    state,
                    selected: applicabilityState(row) === state,
                });
            }
        }
    });

    it('every row is selected by exactly one single-state predicate', () => {
        // No row falls through all three (invisible to the facet) and none is
        // matched by two (double-counted in a multi-select).
        for (const row of ROWS) {
            const hits = APPLICABILITY_STATES.filter((s) => matches(applicabilityStateWhere([s]), row));
            expect({ row: row.id, hits: hits.length }).toEqual({ row: row.id, hits: 1 });
        }
    });
});

describe('isApplicabilityState', () => {
    it('accepts the three states and rejects anything else', () => {
        expect(APPLICABILITY_STATES.every(isApplicabilityState)).toBe(true);
        // 'RESOLVED' is a task status; a URL carried over from another list
        // page must not be treated as a valid facet value.
        expect(['', 'applicable', 'RESOLVED', 'UNKNOWN'].some(isApplicabilityState)).toBe(false);
    });
});
