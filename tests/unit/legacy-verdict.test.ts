/**
 * Step 6c: the verdict table.
 *
 * The table says "the first matching row wins", so the order is part of the
 * design and not an implementation detail. The tests that matter here are the
 * ones where TWO rows would match: they are the only ones an ordering bug can
 * fail, and a per-row test cannot see them.
 */
import {
    derivePersonOnlyVerdict,
    NONE_OPTION,
    NON_VERDICT_REASONS,
    VERDICT_CLASSES,
    deriveVerdict,
    eligibleForBulkRatification,
    type VerdictClass,
} from '@/lib/legacy-access/verdict';
import type { EvaluationThresholds } from '@/app-layer/ai/identity-match/evaluation-record';

const T: EvaluationThresholds = {
    agreeAt: 0.9,
    personAt: 0.8,
    nonPersonAt: 0.2,
    agreeMargin: 0.3,
};

const answer = (
    options: [string, number][],
    personProbability = 0.95
) => ({ options: options.map(([option, probability]) => ({ option, probability })), personProbability });

const engine = (suggestedOption: string | null) => ({ suggestedOption });

describe('each row of the table', () => {
    it('NOT_A_PERSON — P(person) at or below the non-person threshold', () => {
        const r = deriveVerdict(answer([['A', 0.95]], 0.2), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NOT_A_PERSON');
    });

    it('NO_MATCH — P(NONE) at or above accept', () => {
        const r = deriveVerdict(answer([[NONE_OPTION, 0.9], ['A', 0.05]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NO_MATCH');
    });

    it("AGREES — the top option IS the engine's suggestion, clearing every bar", () => {
        const r = deriveVerdict(answer([['A', 0.95], ['B', 0.02]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('AGREES');
        expect(r.topOption).toBe('A');
    });

    it('PROPOSES — the top option is ANOTHER candidate, clearing the same bars', () => {
        const r = deriveVerdict(answer([['B', 0.95], ['A', 0.02]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('PROPOSES');
        expect(r.topOption).toBe('B');
    });

    it('PROPOSES — or the engine had no candidate at all', () => {
        // Null suggestion is what separates the two lanes: with nothing to agree
        // WITH, a confident model is proposing.
        const r = deriveVerdict(answer([['A', 0.95], ['B', 0.02]]), engine(null), T);
        expect(r.verdict).toBe<VerdictClass>('PROPOSES');
    });

    it('UNSURE — anything else', () => {
        const r = deriveVerdict(answer([['A', 0.5], ['B', 0.45]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('UNSURE');
    });

    it('every declared verdict class is reachable', () => {
        const reached = new Set<VerdictClass>([
            deriveVerdict(answer([['A', 0.95]], 0.1), engine('A'), T).verdict,
            deriveVerdict(answer([[NONE_OPTION, 0.95]]), engine('A'), T).verdict,
            deriveVerdict(answer([['A', 0.95], ['B', 0.01]]), engine('A'), T).verdict,
            deriveVerdict(answer([['B', 0.95], ['A', 0.01]]), engine('A'), T).verdict,
            deriveVerdict(answer([['A', 0.4], ['B', 0.39]]), engine('A'), T).verdict,
        ]);
        expect([...VERDICT_CLASSES].filter((c) => !reached.has(c))).toEqual([]);
    });
});

describe('the ORDER, where two rows would match', () => {
    it('NOT_A_PERSON beats AGREES', () => {
        // The case the order exists for: a service account the model is ALSO
        // confident maps to the engine's suggestion. Asking "is this a person"
        // second would bulk-ratify a robot as an employee.
        const r = deriveVerdict(answer([['A', 0.99], ['B', 0.001]], 0.05), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NOT_A_PERSON');
    });

    it('NOT_A_PERSON beats NO_MATCH', () => {
        const r = deriveVerdict(answer([[NONE_OPTION, 0.99]], 0.05), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NOT_A_PERSON');
    });

    it('NO_MATCH beats AGREES when NONE is itself confident', () => {
        // Both could match: NONE clears accept, and A is the suggestion. The
        // model saying "nobody" is the more specific claim and wins.
        const r = deriveVerdict(answer([[NONE_OPTION, 0.95], ['A', 0.92]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NO_MATCH');
    });

    it('NO_MATCH is read off the NONE option, never inferred from low others', () => {
        // "No candidate is likely" and "the answer is nobody" are different
        // statements, and only the second is evidence. With no NONE option
        // supplied, three weak candidates are UNSURE — not NO_MATCH.
        const r = deriveVerdict(answer([['A', 0.2], ['B', 0.2], ['C', 0.2]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('UNSURE');
    });
});

describe('the bars, at their boundaries', () => {
    it('P(person) EXACTLY at nonPersonAt is NOT_A_PERSON — the table says "at or below"', () => {
        const r = deriveVerdict(answer([['A', 0.99]], T.nonPersonAt), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('NOT_A_PERSON');
    });

    it('P(option) EXACTLY at agreeAt clears it — "at or above"', () => {
        const r = deriveVerdict(answer([['A', T.agreeAt], ['B', 0.0]]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('AGREES');
    });

    it('a margin EXACTLY at agreeMargin clears it', () => {
        const r = deriveVerdict(
            answer([['A', 0.95], ['B', 0.95 - T.agreeMargin]]),
            engine('A'),
            T
        );
        expect(r.margin).toBeCloseTo(T.agreeMargin, 10);
        expect(r.verdict).toBe<VerdictClass>('AGREES');
    });

    it('a margin just under it is UNSURE, not AGREES', () => {
        const r = deriveVerdict(answer([['A', 0.95], ['B', 0.70]]), engine('A'), T);
        expect(r.margin).toBeCloseTo(0.25, 10);
        expect(r.verdict).toBe<VerdictClass>('UNSURE');
    });

    it('P(person) EXACTLY at personAt clears the AGREES bar', () => {
        const r = deriveVerdict(answer([['A', 0.95], ['B', 0.0]], T.personAt), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('AGREES');
    });

    it('a sole option is unopposed: margin Infinity, not its own score', () => {
        const r = deriveVerdict(answer([['A', 0.95]]), engine('A'), T);
        expect(r.margin).toBe(Number.POSITIVE_INFINITY);
        expect(r.verdict).toBe<VerdictClass>('AGREES');
    });

    it('no options at all is UNSURE with no top option', () => {
        const r = deriveVerdict(answer([]), engine('A'), T);
        expect(r.verdict).toBe<VerdictClass>('UNSURE');
        expect(r.topOption).toBeNull();
        expect(r.margin).toBe(0);
    });

    it('the ranking is deterministic when two options tie', () => {
        const a = deriveVerdict(answer([['A', 0.5], ['B', 0.5]]), engine('A'), T);
        const b = deriveVerdict(answer([['B', 0.5], ['A', 0.5]]), engine('A'), T);
        expect(a.topOption).toBe(b.topOption);
        // And a tie cannot clear the margin, so it cannot be AGREES.
        expect(a.margin).toBe(0);
        expect(a.verdict).toBe<VerdictClass>('UNSURE');
    });

    it('NONE is never the top option of an AGREES or PROPOSES', () => {
        // Guarded explicitly: a confident NONE below the accept bar would
        // otherwise fall through to the shared-bars branch and be PROPOSED as
        // if it were a candidate.
        const r = deriveVerdict(answer([[NONE_OPTION, 0.85], ['A', 0.1]]), engine('A'), T);
        expect(r.verdict).not.toBe<VerdictClass>('AGREES');
        expect(r.verdict).not.toBe<VerdictClass>('PROPOSES');
    });
});

describe('bulk ratification needs more than AGREES', () => {
    const base = {
        verdict: 'AGREES' as VerdictClass,
        candidateIsActive: true,
        hasVeto: false,
        isPrivileged: false,
        isRekeyed: false,
        blindHeld: false,
    };

    it('an AGREES row clearing every candidate bar is eligible', () => {
        expect(eligibleForBulkRatification(base)).toBe(true);
    });

    it.each([
        ['an inactive candidate', { candidateIsActive: false }],
        ['a veto', { hasVeto: true }],
        ['privilege', { isPrivileged: true }],
        ['a re-key', { isRekeyed: true }],
        ['being blind-held', { blindHeld: true }],
    ])('%s makes it ineligible', (_label, over) => {
        expect(eligibleForBulkRatification({ ...base, ...over })).toBe(false);
    });

    it.each(['PROPOSES', 'NOT_A_PERSON', 'NO_MATCH', 'UNSURE'] as VerdictClass[])(
        '%s is never eligible, however clean the candidate',
        (verdict) => {
            expect(eligibleForBulkRatification({ ...base, verdict })).toBe(false);
        }
    );
});

describe('the non-verdict reasons', () => {
    it('all ten are declared, and they are the ten the brief names', () => {
        expect([...NON_VERDICT_REASONS].sort()).toEqual([
            'BREAKER_OPEN', 'DEADLINE', 'KILL_SWITCH', 'MODEL_DRIFT', 'NO_EVALUATION',
            'NO_PROVIDER', 'OVER_BUDGET', 'PROVIDER_ERROR', 'QUARANTINED', 'TIMEOUT',
        ]);
        expect(NON_VERDICT_REASONS).toHaveLength(10);
    });
});

describe('the module cannot reach a writer', () => {
    it('imports nothing that writes a resolution or an alias', () => {
        // The guarantee the step's hardening list asks for: "no path leads from
        // a verdict to LINKED, to a changed outcome, or to an alias". Proven by
        // loading the module with every writer mocked to throw ON LOAD, so a
        // transitive import fails the test rather than a text scan missing it.
        jest.isolateModules(() => {
            for (const writer of [
                '@/app-layer/usecases/legacy-reconcile',
                '@/app-layer/usecases/legacy-reviewer-actions',
            ]) {
                jest.doMock(writer, () => {
                    throw new Error(`verdict.ts must not import ${writer}`);
                });
            }
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('@/lib/legacy-access/verdict');
            }).not.toThrow();
        });
    });
});

// ── Step 6c: the orphan's person-only derivation ────────────────────────────
//
// Only two verdicts are reachable, and the reason this is its own function
// rather than `deriveVerdict` with an empty option list is that the empty list
// gives the right answer BY ACCIDENT. It would stop doing so the moment
// somebody computed P(NONE) as `1 - sum(others)` — a reasonable thing to write,
// and one that would make every orphan a confident NO_MATCH.
describe('derivePersonOnlyVerdict', () => {
    const T = { agreeAt: 0.8, personAt: 0.7, nonPersonAt: 0.2, agreeMargin: 0.2 };

    it('is NOT_A_PERSON at or below the non-person threshold', () => {
        expect(derivePersonOnlyVerdict(0.2, T).verdict).toBe('NOT_A_PERSON');
        expect(derivePersonOnlyVerdict(0.05, T).verdict).toBe('NOT_A_PERSON');
    });

    it('is UNSURE just above it', () => {
        // Both boundary directions, as everywhere else in this file.
        expect(derivePersonOnlyVerdict(0.201, T).verdict).toBe('UNSURE');
    });

    it('is UNSURE even when the model is CERTAIN it is a person', () => {
        // A confident "this IS a person" on an account with nobody on the
        // roster is the orphan finding itself. The design annotates that; it
        // does not give it a verdict class, and it must never become a match.
        expect(derivePersonOnlyVerdict(1, T).verdict).toBe('UNSURE');
    });

    it.each(['NO_MATCH', 'AGREES', 'PROPOSES'])('can never return %s', (forbidden) => {
        // The whole population of inputs, at a resolution far finer than the
        // thresholds. If any probability produced a match-shaped verdict, the
        // orphan change would have reintroduced the vacuous NO_MATCH it exists
        // to remove.
        for (let p = 0; p <= 1.0001; p += 0.005) {
            expect(derivePersonOnlyVerdict(Math.min(p, 1), T).verdict).not.toBe(forbidden);
        }
    });

    it('reports no option, and an INFINITE margin', () => {
        const v = derivePersonOnlyVerdict(0.9, T);
        expect(v.topOption).toBeNull();
        expect(v.topProbability).toBe(0);
        // Infinity, not zero: there was no runner-up to be ahead of, and zero
        // would mean "tied with something". Same reading `deriveVerdict` gives
        // a sole option.
        expect(v.margin).toBe(Number.POSITIVE_INFINITY);
    });
});
