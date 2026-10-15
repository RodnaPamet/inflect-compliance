/**
 * Step 4a: naming conventions and similarity, and the proof that neither can
 * reach `LINKED`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THING THIS SUITE EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Step 3b made "no supporting signal can link" a type error, and proved it
 * exhaustively over all 127 subsets of the supporting kinds — at a score of 10,000
 * each — before any of them had an implementation. This step supplies the
 * implementations.
 *
 * So the question here is not whether the type holds; it is whether the REAL
 * scorers, on real inputs, still only ever reach `SUGGESTED` or `AMBIGUOUS`. The
 * corpus run at the bottom is the answer: the engine with both scorers wired in,
 * over every case, asserting zero false links and that the three expected links
 * are still the only links.
 */

import {
    reconcile,
    strengthOf,
    SUPPORTING_SIGNAL_KINDS,
    STRONG_SIGNAL_KINDS,
    type CanonicalAccount,
    type RosterEmployee,
    type CandidateScorer,
    type CandidateBlocker,
    type SupportingSignal,
} from '@/lib/identity/reconcile/engine';
import {
    CANDIDATE_TEMPLATES,
    ConventionSyntaxError,
    MAX_TEMPLATE_LENGTH,
    generateUsername,
    matchConvention,
    nameParts,
    parseConvention,
    proposeConventions,
} from '@/lib/identity/reconcile/conventions';
import { jaro, jaroWinkler, tokenSetRatio, scoreNames } from '@/lib/identity/reconcile/similarity';
import {
    makeConventionScorer,
    makeSimilarityScorer,
    makeDepartmentScorer,
    step4aExtensions,
    SCORER_WEIGHTS,
} from '@/lib/identity/reconcile/scorers';
import { CORPUS, engineInputFor } from '../fixtures/identity-reconcile/corpus';
// The bulk bound, imported so #3560's "same number" assertion compares the
// two real constants rather than one constant against a literal.
import { BULK_MIN_MARGIN } from '@/app-layer/usecases/legacy-reviewer-actions';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const NOW = '2026-10-08T00:00:00.000Z';

const john: RosterEmployee = {
    id: 'e-john',
    fullName: 'John Smith',
    givenName: 'John',
    familyName: 'Smith',
    status: 'ACTIVE',
};
const jane: RosterEmployee = {
    id: 'e-jane',
    fullName: 'Jane Smith',
    givenName: 'Jane',
    familyName: 'Smith',
    status: 'ACTIVE',
};

function run(
    account: CanonicalAccount,
    roster: readonly RosterEmployee[],
    convention?: string | null
) {
    const r = reconcile({
        accounts: [account],
        roster,
        directory: [],
        aliases: [],
        now: NOW,
        config: step4aExtensions(roster, convention ?? null),
    });
    return r.resolutions[0];
}

// ─── The grammar ───────────────────────────────────────────────────────────

describe('4a grammar — the parser', () => {
    it.each([
        '{f}{last}',
        '{first}.{last}',
        '{first}_{last}',
        '{last}{f}',
        '{F}{last}',
        '{f}{m}{last}',
        '{f}{last}{n?}',
        '{first}-{last}',
    ])('accepts %s', (t) => {
        expect(() => parseConvention(t)).not.toThrow();
    });

    it.each([
        ['{dept}{last}', 'unknown token'],
        ['{hiredYear}', 'unknown token'],
        ['{first}{last', 'unclosed'],
        ['', 'empty'],
        ['{n?}', 'no name token'],
        ['{n?}{last}', 'must be last'],
        ['{f}{n?}{last}', 'must be last'],
        ['{f}{n?}{n?}', 'must be last'],
        ['{f}@{last}', 'not a separator run'],
        ['{f}  {last}', 'not a separator run'],
        ['literal-only', 'not a separator run'],
    ])('rejects %s', (t, because) => {
        expect(() => parseConvention(t)).toThrow(ConventionSyntaxError);
        expect(() => parseConvention(t)).toThrow(new RegExp(because));
    });

    it('bounds the template length', () => {
        const long = `{f}${'.'.repeat(4)}`.repeat(20);
        expect(long.length).toBeGreaterThan(MAX_TEMPLATE_LENGTH);
        expect(() => parseConvention(long)).toThrow(/longer than/);
    });

    it('rejects a template with no name token, which would match everyone', () => {
        expect(() => parseConvention('...')).toThrow(ConventionSyntaxError);
    });

    it('every shipped candidate template parses', () => {
        // The denominator: a candidate list with a typo in it would otherwise be
        // silently skipped by the proposer and report 0% for a template nobody
        // can see is malformed.
        expect(CANDIDATE_TEMPLATES.length).toBeGreaterThanOrEqual(8);
        for (const t of CANDIDATE_TEMPLATES) expect(() => parseConvention(t)).not.toThrow();
    });
});

// ─── Name parts: never guess a split ───────────────────────────────────────

describe('4a conventions — a name that cannot be split generates nothing', () => {
    const c = parseConvention('{f}{last}');

    it('uses givenName and familyName when present', () => {
        expect(nameParts({ id: 'x', givenName: 'John', familyName: 'Smith' })).toEqual({
            given: 'John',
            family: 'Smith',
            middle: '',
        });
    });

    it('splits a fullName of EXACTLY two tokens', () => {
        expect(nameParts({ id: 'x', fullName: 'John Smith' })).toMatchObject({
            given: 'John',
            family: 'Smith',
        });
    });

    it('a mononym generates nothing', () => {
        expect(nameParts({ id: 'x', fullName: 'Prince' })).toBeNull();
        expect(generateUsername(c, { id: 'x', fullName: 'Prince' })).toBeNull();
    });

    it('a three-part name generates nothing — the split has two readings', () => {
        // "Maria del Carmen" would become `mdel` under a guess, and `mdel` matching
        // somebody is a confident-looking convention signal for the wrong person.
        expect(nameParts({ id: 'x', fullName: 'Maria del Carmen' })).toBeNull();
        expect(generateUsername(c, { id: 'x', fullName: 'Maria del Carmen Garcia' })).toBeNull();
    });

    it('a missing name part generates nothing', () => {
        expect(generateUsername(c, { id: 'x', givenName: 'John' })).toBeNull();
        expect(generateUsername(c, { id: 'x', familyName: 'Smith' })).toBeNull();
        expect(generateUsername(c, { id: 'x' })).toBeNull();
    });

    it('a {middle} template over somebody with no middle name generates nothing', () => {
        // Rather than collapsing the token and inventing a different username.
        const withMiddle = parseConvention('{f}{m}{last}');
        expect(generateUsername(withMiddle, { id: 'x', givenName: 'John', familyName: 'Smith' })).toBeNull();
        expect(
            generateUsername(withMiddle, {
                id: 'x',
                givenName: 'John',
                middleNames: ['Quincy'],
                familyName: 'Smith',
            })
        ).toBe('jqsmith');
    });

    it('generates the expected username for each token form', () => {
        const e = { id: 'x', givenName: 'John', middleNames: ['Quincy'], familyName: 'Smith' };
        expect(generateUsername(parseConvention('{f}{last}'), e)).toBe('jsmith');
        expect(generateUsername(parseConvention('{first}.{last}'), e)).toBe('john.smith');
        expect(generateUsername(parseConvention('{last}{f}'), e)).toBe('smithj');
        expect(generateUsername(parseConvention('{first}{l}'), e)).toBe('johns');
        // Upper-case tokens DESCRIBE a system's style; the comparison is still
        // case-insensitive, so they generate the same lower-cased key.
        expect(generateUsername(parseConvention('{F}{LAST}'), e)).toBe('jsmith');
    });
});

// ─── A collision is AMBIGUOUS ──────────────────────────────────────────────

describe('4a conventions — a collision yields AMBIGUOUS, never a pick', () => {
    it('John and Jane Smith both generating jsmith is AMBIGUOUS', () => {
        const res = run({ accountKey: 'jsmith', displayName: null }, [john, jane], '{f}{last}');
        expect(res.outcome).toBe('AMBIGUOUS');
        expect(res.employeeId).toBeNull();
    });

    it('matchConvention returns BOTH, and says it collides', () => {
        const m = matchConvention(parseConvention('{f}{last}'), 'jsmith', [john, jane]);
        expect(m.employeeIds).toEqual(['e-jane', 'e-john']);
        expect(m.collides).toBe(true);
    });

    it('the colliding candidates are scored EQUALLY, which is what makes it a tie', () => {
        // If the scorer broke the tie itself, the engine would see a clear leader
        // and emit SUGGESTED — a confident suggestion for a genuine ambiguity.
        const scorer = makeConventionScorer('{f}{last}', [john, jane]);
        const account: CanonicalAccount = { accountKey: 'jsmith' };
        const a = scorer(account, john, { accountName: {} as never, accountEmail: {} as never, accountUsername: {} as never, now: NOW });
        const b = scorer(account, jane, { accountName: {} as never, accountEmail: {} as never, accountUsername: {} as never, now: NOW });
        expect(a[0].score).toBe(b[0].score);
    });

    it('a unique convention match is SUGGESTED, not LINKED', () => {
        const res = run({ accountKey: 'jsmith', displayName: null }, [john], '{f}{last}');
        expect(res.outcome).toBe('SUGGESTED');
        expect(res.employeeId).toBe('e-john');
        expect(res.method).toBe('SUPPORTING_ONLY');
    });

    it('honours a trailing counter', () => {
        const res = run({ accountKey: 'jsmith2', displayName: null }, [john], '{f}{last}{n?}');
        expect(res.outcome).toBe('SUGGESTED');
        expect(res.employeeId).toBe('e-john');
    });

    it('does NOT strip a counter when the template does not allow one', () => {
        const res = run({ accountKey: 'jsmith2', displayName: null }, [john], '{f}{last}');
        expect(res.outcome).not.toBe('SUGGESTED');
    });
});

// ─── Jaro-Winkler against published values ─────────────────────────────────

describe('4a similarity — the published reference values', () => {
    it.each([
        ['MARTHA', 'MARHTA', 0.961],
        ['DWAYNE', 'DUANE', 0.84],
        ['DIXON', 'DICKSONX', 0.813],
    ])('jaroWinkler(%s, %s) === %f', (a, b, want) => {
        expect(jaroWinkler(a, b)).toBeCloseTo(want, 3);
    });

    it('is total: empty, single-character and disjoint inputs all have answers', () => {
        expect(jaro('', '')).toBe(1);
        expect(jaro('a', '')).toBe(0);
        expect(jaro('', 'a')).toBe(0);
        expect(jaroWinkler('a', 'a')).toBe(1);
        expect(jaroWinkler('abc', 'xyz')).toBe(0);
    });

    it('is symmetric', () => {
        for (const [a, b] of [['MARTHA', 'MARHTA'], ['DWAYNE', 'DUANE'], ['Ivan', 'Ivana']]) {
            expect(jaroWinkler(a, b)).toBeCloseTo(jaroWinkler(b, a), 10);
        }
    });

    it('token-set ratio handles reordering, which Jaro-Winkler does not', () => {
        // The reason both exist. `Smith, John A.` against `John Smith`:
        expect(tokenSetRatio('Smith, John A.', 'John Smith')).toBeCloseTo(2 / 3, 5);
        expect(jaroWinkler('smith, john a.', 'john smith')).toBeLessThan(0.7);
    });

    it('keeps the two measures separate rather than blending them', () => {
        const s = scoreNames('Smith, John', 'John Smith');
        expect(s.jaroWinkler).not.toBeCloseTo(s.tokenSet, 2);
        expect(s.best).toBe(Math.max(s.jaroWinkler, s.tokenSet));
    });
});

// ─── The similarity floor ──────────────────────────────────────────────────

describe('4a — the similarity floor keeps noise out of a reviewer list', () => {
    /**
     * Added because a mutation found it untested: setting the floor to 0 — so that
     * every pair emits a signal however poorly it scores — broke nothing in the
     * first version of this suite. A threshold with no test is a number anybody can
     * change, and this one decides what a human is asked to look at.
     */
    const roster: RosterEmployee[] = [
        { id: 'e-smith', fullName: 'John Smith', givenName: 'John', familyName: 'Smith', status: 'ACTIVE' },
    ];

    it('emits nothing for a pair whose names merely share letters', () => {
        const scorer = makeSimilarityScorer();
        const ctx = { accountName: {} as never, accountEmail: {} as never, accountUsername: {} as never, now: NOW };
        // "Mei Tan" against "John Smith": some shared characters, no relationship.
        const weak = scorer({ accountKey: 'mtan', displayName: 'Mei Tan' }, roster[0], ctx);
        expect(weak).toEqual([]);
    });

    it('emits for a pair above the floor', () => {
        const scorer = makeSimilarityScorer();
        const ctx = { accountName: {} as never, accountEmail: {} as never, accountUsername: {} as never, now: NOW };
        const strong = scorer({ accountKey: 'jsmith', displayName: 'Jon Smith' }, roster[0], ctx);
        expect(strong).toHaveLength(1);
        expect(strong[0].kind).toBe('SIMILARITY');
    });

    it('the floor is where the scorer says it is, and it discriminates', () => {
        // The pair above must clear it and the pair below must not — otherwise the
        // two assertions above could both hold with the floor set anywhere.
        const above = scoreNames('Jon Smith', 'John Smith').best;
        const below = scoreNames('Mei Tan', 'John Smith').best;
        expect(above).toBeGreaterThanOrEqual(SCORER_WEIGHTS.SIMILARITY_FLOOR);
        expect(below).toBeLessThan(SCORER_WEIGHTS.SIMILARITY_FLOOR);
    });

    it('a weak pair reaching the engine produces no suggestion from similarity alone', () => {
        const res = run({ accountKey: 'mtan', displayName: 'Mei Tan' }, roster, null);
        const kinds = res.candidates.flatMap((c) => c.signals.map((x) => x.kind));
        expect(kinds).not.toContain('SIMILARITY');
    });
});

// ─── Transliteration records its scheme ────────────────────────────────────

describe('4a — a match found through transliteration records its scheme', () => {
    it('similarity tags the scheme and stays at SUGGESTED', () => {
        const ivan: RosterEmployee = {
            id: 'e-ivan',
            fullName: 'Ivan Ivanov',
            givenName: 'Ivan',
            familyName: 'Ivanov',
            status: 'ACTIVE',
        };
        const res = run({ accountKey: 'iivanov', displayName: 'Иван Иванов' }, [ivan], null);
        expect(res.outcome).toBe('SUGGESTED');
        expect(res.employeeId).toBe('e-ivan');
        const kinds = res.signals.map((s) => s.kind);
        expect(kinds).toContain('NAME_TRANSLIT');
        const sig = res.signals.find((s) => s.kind === 'NAME_TRANSLIT')!;
        expect(sig.evidence).toMatch(/via /);
        // At most SUGGESTED, whatever the score.
        expect(res.outcome).not.toBe('LINKED');
    });

    it('a convention match through transliteration records its scheme and scores lower', () => {
        const ivan: RosterEmployee = {
            id: 'e-ivan',
            fullName: 'Иван Иванов',
            givenName: 'Иван',
            familyName: 'Иванов',
            status: 'ACTIVE',
        };
        const m = matchConvention(parseConvention('{f}{last}'), 'iivanov', [ivan]);
        expect(m.employeeIds).toEqual(['e-ivan']);
        expect(m.scheme).not.toBeNull();
        expect(SCORER_WEIGHTS.CONVENTION_TRANSLITERATED).toBeLessThan(SCORER_WEIGHTS.CONVENTION);
    });
});

// ─── Similarity runs only within blocks ────────────────────────────────────

describe('4a — similarity runs only within blocks', () => {
    it('is never called for a pair blocking did not produce, proven by count', () => {
        let calls = 0;
        const counting = makeSimilarityScorer();
        const wrapped: typeof counting = (a, c, ctx) => {
            calls += 1;
            return counting(a, c, ctx);
        };

        // 200 employees, all with distinct emails; one account that blocks to
        // exactly one of them by exact email.
        const roster: RosterEmployee[] = Array.from({ length: 200 }, (_, i) => ({
            id: `e-${i}`,
            fullName: `Person ${i}`,
            workEmail: `person${i}@corp.example.test`,
            status: 'ACTIVE' as const,
        }));
        const r = reconcile({
            accounts: [{ accountKey: 'p7', email: 'person7@corp.example.test', displayName: 'Person 7' }],
            roster,
            directory: [],
            aliases: [],
            now: NOW,
            config: { scorers: [wrapped] },
        });

        expect(r.resolutions).toHaveLength(1);
        // ONE comparison, not 200. A scorer called outside its pair would make the
        // engine's own comparison budget meaningless.
        expect(calls).toBe(1);
        expect(r.metrics.comparisons).toBe(1);
    });

    it('a convention scorer memoises per account rather than per pair', () => {
        // Otherwise each blocked pair re-scans the whole roster and the blocking
        // index is undone from the outside.
        const roster: RosterEmployee[] = Array.from({ length: 50 }, (_, i) => ({
            id: `e-${i}`,
            fullName: `Person${i} Smith`,
            givenName: `Person${i}`,
            familyName: 'Smith',
            workEmail: `p${i}@corp.example.test`,
            status: 'ACTIVE' as const,
        }));
        const scorer = makeConventionScorer('{first}.{last}', roster);
        const account: CanonicalAccount = { accountKey: 'person7.smith' };
        const ctx = { accountName: {} as never, accountEmail: {} as never, accountUsername: {} as never, now: NOW };
        // Two calls for the same account must agree, and the second is served from
        // the memo — asserted behaviourally, by the answer being stable.
        const a = scorer(account, roster[7], ctx);
        const b = scorer(account, roster[7], ctx);
        expect(a).toEqual(b);
        expect(a).toHaveLength(1);
    });
});

// ─── The proposer measures; it does not adopt ──────────────────────────────

describe('4a — the proposer reports shares and adopts nothing', () => {
    const roster: RosterEmployee[] = [john, jane, {
        id: 'e-amy',
        fullName: 'Amy Jones',
        givenName: 'Amy',
        familyName: 'Jones',
        status: 'ACTIVE',
    }];

    it('reports a share per template, highest first', () => {
        const logins = ['ajones', 'john.smith', 'jane.smith'];
        const proposals = proposeConventions(logins, roster);
        expect(proposals.length).toBeGreaterThan(0);
        for (let i = 1; i < proposals.length; i++) {
            expect(proposals[i - 1].share).toBeGreaterThanOrEqual(proposals[i].share);
        }
        const dotted = proposals.find((p) => p.template === '{first}.{last}')!;
        expect(dotted.explainedUniquely).toBe(2);
        expect(dotted.total).toBe(3);
    });

    it('counts a colliding explanation separately, never as success', () => {
        // `jsmith` is explained by {f}{last} — for two people. That is not an
        // explanation, and counting it would make the worst template look best.
        const proposals = proposeConventions(['jsmith'], roster);
        const initial = proposals.find((p) => p.template === '{f}{last}')!;
        expect(initial.explainedUniquely).toBe(0);
        expect(initial.explainedAmbiguously).toBe(1);
        expect(initial.share).toBe(0);
    });

    it('returns no "best" — a human picks', () => {
        const proposals = proposeConventions(['ajones'], roster);
        // The shape is a list. There is no `adopted`, no `recommended`, no single
        // return: adopting is a decision somebody makes and audits.
        expect(Array.isArray(proposals)).toBe(true);
        expect(proposals[0]).not.toHaveProperty('adopted');
    });

    it('is total on an empty snapshot', () => {
        const proposals = proposeConventions([], roster);
        expect(proposals.every((p) => p.share === 0 && p.total === 0)).toBe(true);
    });
});

// ─── Neither signal can link: the table, and then the corpus ──────────────

describe('4a — neither signal ever produces LINKED', () => {
    /** Every combination of (convention present?) × (similarity present?) × collision. */
    const cases: ReadonlyArray<{
        readonly name: string;
        readonly account: CanonicalAccount;
        readonly roster: readonly RosterEmployee[];
        readonly convention: string | null;
    }> = [
        { name: 'convention only, unique', account: { accountKey: 'jsmith' }, roster: [john], convention: '{f}{last}' },
        { name: 'convention only, collision', account: { accountKey: 'jsmith' }, roster: [john, jane], convention: '{f}{last}' },
        { name: 'similarity only', account: { accountKey: 'x', displayName: 'Jon Smith' }, roster: [john], convention: null },
        { name: 'both, agreeing', account: { accountKey: 'jsmith', displayName: 'John Smith' }, roster: [john], convention: '{f}{last}' },
        { name: 'both, disagreeing', account: { accountKey: 'jsmith', displayName: 'Jane Smith' }, roster: [john, jane], convention: '{f}{last}' },
        { name: 'exact display-name match', account: { accountKey: 'x', displayName: 'John Smith' }, roster: [john], convention: null },
        { name: 'transliterated', account: { accountKey: 'iivanov', displayName: 'Иван Иванов' }, roster: [{ id: 'e-i', fullName: 'Ivan Ivanov', givenName: 'Ivan', familyName: 'Ivanov', status: 'ACTIVE' }], convention: '{f}{last}' },
    ];

    it.each(cases.map((c) => [c.name, c] as const))('%s never links', (_name, c) => {
        const res = run(c.account, c.roster, c.convention);
        expect(res.outcome).not.toBe('LINKED');
        // NOT merely "not LINKED". Every case here must actually reach a scorer —
        // the first version allowed UNMATCHED, and before the blocking extension
        // point existed these cases ALL returned NO_CANDIDATES, so the whole table
        // passed while proving nothing. A case that produces no candidate is not
        // evidence that a signal cannot link; it is evidence the signal never ran.
        expect(['SUGGESTED', 'AMBIGUOUS']).toContain(res.outcome);
        expect(res.candidates.length).toBeGreaterThan(0);
        const kinds = res.candidates.flatMap((x) => x.signals.map((sig) => sig.kind));
        expect(kinds.length).toBeGreaterThan(0);
        // And every signal in play is a SUPPORTING one, which is what makes the
        // "cannot link" claim about these scorers rather than about the engine.
        for (const k of kinds) {
            expect(['USERNAME_CONVENTION', 'SIMILARITY', 'NAME_TRANSLIT', 'NAME_EXACT', 'NAME_INITIAL', 'EMAIL_UNTAGGED', 'STALE_DIRECTORY_LINK']).toContain(k);
        }
    });

    it('covers every combination it claims to, so the table is not thin', () => {
        expect(cases).toHaveLength(7);
    });
});

describe('4a — the precision ratchet holds with both scorers wired in', () => {
    it('adds no false link over the Step 3a corpus, and keeps the three real ones', () => {
        const expectedLinks = CORPUS.filter((c) => c.expected.outcome === 'LINKED');
        const falseLinks: string[] = [];
        const correct: string[] = [];
        let suggestedNow = 0;

        for (const c of CORPUS) {
            const roster = c.hr as readonly RosterEmployee[];
            const r = reconcile({
                // Through the fixture's own builder. This site had
                // `aliases: []` hardcoded, which made every alias case in the
                // corpus an unsatisfiable LINKED — the ratchet below counted it
                // as a missing link and read as a 4a regression.
                ...engineInputFor(c),
                now: NOW,
                // Both scorers AND both blockers — the scorers are unreachable for a
                // name-only account without the blockers, which is the gap this step
                // found in Step 3b's extension surface.
                config: step4aExtensions(roster, '{f}{last}'),
            });
            const res = r.resolutions[0];
            if (res.outcome === 'SUGGESTED') suggestedNow += 1;
            if (res.outcome !== 'LINKED') continue;
            if (c.expected.outcome === 'LINKED' && c.expected.employeeId === res.employeeId) {
                correct.push(c.id);
            } else {
                falseLinks.push(`${c.id}: linked ${res.employeeId} via ${res.method} — ${c.why}`);
            }
        }

        console.log(
            [
                '',
                '  ── Step 3b engine + Step 4a scorers, over the Step 3a corpus ──',
                `  cases              ${CORPUS.length}`,
                `  false links        ${falseLinks.length}   (GATED: must be 0)`,
                `  expected links hit ${correct.length}/${expectedLinks.length}   (GATED: must be all)`,
                `  SUGGESTED now      ${suggestedNow}   (was 3 with the engine alone — 4a's whole purpose)`,
                '',
            ].join('\n')
        );

        expect(falseLinks).toEqual([]);
        expect(correct).toHaveLength(expectedLinks.length);
        // 4a must actually MOVE cases, or it has added two signals and no value.
        expect(suggestedNow).toBeGreaterThan(3);
    });
});

/**
 * The department scorer: a second opinion, and nothing more (#3516).
 *
 * Seven residue rows rest on `NAME_TRANSLIT` alone and five on `SIMILARITY`
 * alone, and every other supporting kind restates a name, an address or a
 * directory link. A shared department is the cheapest genuinely independent
 * fact the engine already holds on both sides.
 *
 * What these assert is mostly what it CANNOT do, because that is where the risk
 * is: a department identifies nobody, so the failure mode is corroborating
 * everything.
 */
describe('makeDepartmentScorer — corroborates, never identifies (#3516)', () => {
    const scorer = makeDepartmentScorer();
    const acct = (department?: string | null) => ({ accountKey: 'x', displayName: 'X', department });
    const cand = (department?: string | null) => ({
        id: 'e-1', fullName: 'Someone', status: 'ACTIVE' as const, department,
    });

    it('emits DEPARTMENT_MATCH when both sides name the same unit', () => {
        const out = scorer(acct('Finance') as never, cand('Finance') as never, {} as never);
        expect(out.map((s) => s.kind)).toEqual(['DEPARTMENT_MATCH']);
        // The VALUE is the evidence, so a reviewer sees which department agreed
        // rather than being told that one did.
        expect(out[0].evidence).toBe('finance');
    });

    it('ignores case and surrounding whitespace, and nothing else', () => {
        expect(scorer(acct(' FINANCE ') as never, cand('finance') as never, {} as never)).toHaveLength(1);
        // Internal punctuation is NOT folded: neighbouring teams must not be
        // manufactured into agreement, the same line EMAIL_EXACT draws.
        expect(scorer(acct('Finance & Controlling') as never, cand('Finance') as never, {} as never)).toEqual([]);
    });

    it('treats ABSENCE as no match, on either side', () => {
        // The failure mode that matters. A source system that leaves the field
        // blank would otherwise have every weak name match corroborated.
        expect(scorer(acct(null) as never, cand(null) as never, {} as never)).toEqual([]);
        expect(scorer(acct('Finance') as never, cand(null) as never, {} as never)).toEqual([]);
        expect(scorer(acct(null) as never, cand('Finance') as never, {} as never)).toEqual([]);
        expect(scorer(acct('  ') as never, cand('  ') as never, {} as never)).toEqual([]);
    });

    it('is classified SUPPORTING, so it can never reach LINKED', () => {
        // The guarantee itself is proven for every subset of the supporting
        // kinds at score 10,000 by `identity-reconcile-precision`'s exhaustive
        // test, which enumerates the union — so adding this kind extended that
        // proof automatically. This asserts the classification the proof rests
        // on, because a kind reclassified STRONG would pass that test's
        // enumeration while changing everything.
        expect(strengthOf('DEPARTMENT_MATCH')).toBe('SUPPORTING');
        expect(SUPPORTING_SIGNAL_KINDS).toContain('DEPARTMENT_MATCH');
        expect(STRONG_SIGNAL_KINDS).not.toContain('DEPARTMENT_MATCH');
    });

    it('stays below the weight the bulk action is bounded by', () => {
        // `legacy-reviewer-actions` bounds bulk confirmation by the largest
        // score a single supporting signal can contribute. A weight at or above
        // CONVENTION would re-tune who qualifies for bulk, silently.
        expect(SCORER_WEIGHTS.DEPARTMENT).toBeLessThan(SCORER_WEIGHTS.CONVENTION);
        expect(SCORER_WEIGHTS.DEPARTMENT).toBeLessThan(SCORER_WEIGHTS.SIMILARITY_SCALE);
    });

    it('adds a SECOND signal to a translit-only row, and changes nothing else', () => {
        // THE CLAIM, end to end through the real engine rather than the scorer
        // in isolation: a row that rested on one signal now rests on two, and
        // the outcome is identical.
        //
        // Built here rather than in the corpus because THE CORPUS CARRIES NO
        // DEPARTMENTS AT ALL — `department:` occurs zero times in
        // `corpus.ts`, so this signal fires on none of its 30 cases. Adding the
        // field to existing cases is not a cosmetic edit either: at +40 it can
        // separate two candidates that currently tie, turning an AMBIGUOUS into
        // a SUGGESTED. So the demonstration lives here and the corpus is left
        // alone.
        const account = {
            accountKey: 'gshterev',
            displayName: 'Георги Щерев',
            department: 'Internal Audit',
        } as CanonicalAccount;
        const employee = {
            id: 'e-1',
            fullName: 'Georgi Shterev',
            givenName: 'Georgi',
            familyName: 'Shterev',
            status: 'ACTIVE' as const,
            department: 'Internal Audit',
        } as RosterEmployee;

        const run = (acct: CanonicalAccount, emp: RosterEmployee) => {
            const { scorers, blockers } = step4aExtensions([emp], null);
            const r = reconcile({
                accounts: [acct], roster: [emp], directory: [], aliases: [],
                now: '2026-10-08T00:00:00.000Z', config: { scorers, blockers },
            });
            const res = r.resolutions[0];
            return { outcome: res.outcome, kinds: res.signals.map((x) => x.kind).sort() };
        };

        // Without the department on either side — one signal.
        const before = run(
            { ...account, department: null } as CanonicalAccount,
            { ...employee, department: null } as RosterEmployee,
        );
        expect(before.kinds).toEqual(['NAME_TRANSLIT']);

        // With it — two independent signals, SAME outcome.
        const after = run(account, employee);
        expect(after.kinds).toEqual(['DEPARTMENT_MATCH', 'NAME_TRANSLIT']);
        expect(after.outcome).toBe(before.outcome);
    });

    it('does not separate two candidates that share the department', () => {
        // The tie it must NOT break. Both candidates sit in the same unit, so
        // both receive the signal and the engine's equal-score rule is
        // untouched — it can only separate candidates who actually differ.
        const acctT = { accountKey: 'apetrov', displayName: 'A. Petrov', department: 'Finance' } as CanonicalAccount;
        const two = [
            { id: 'e-1', fullName: 'Angel Petrov', givenName: 'Angel', familyName: 'Petrov', status: 'ACTIVE' as const, department: 'Finance' },
            { id: 'e-2', fullName: 'Anton Petrov', givenName: 'Anton', familyName: 'Petrov', status: 'ACTIVE' as const, department: 'Finance' },
        ] as RosterEmployee[];
        const { scorers, blockers } = step4aExtensions(two, null);
        const r = reconcile({
            accounts: [acctT], roster: two, directory: [], aliases: [],
            now: '2026-10-08T00:00:00.000Z', config: { scorers, blockers },
        });
        const scores = r.resolutions[0].candidates.map((c) => c.score);
        expect(new Set(scores).size).toBe(1);
    });

    it('is wired into step4aExtensions, which is what production calls', () => {
        // Code-complete is not running. `legacy-reconcile.ts` calls this
        // function and nothing else assembles the scorer list.
        const { scorers } = step4aExtensions([cand('Finance') as never], null);
        const signals = scorers.flatMap((s) =>
            s(acct('Finance') as never, cand('Finance') as never, {} as never),
        );
        expect(signals.map((x) => x.kind)).toContain('DEPARTMENT_MATCH');
    });
});

/**
 * A lead thinner than one whole signal is not a choice (#3560).
 *
 * MEASURED FIRST, over both fixture sets with 4a wired as production wires it:
 * `AMBIGUOUS` was reached by **ZERO of 45 cases**. The outcome existed, its
 * badge was rendered `error` — "the row a reviewer must not skim past" — and no
 * case produced it.
 *
 * The reason is structural rather than accidental. `AMBIGUOUS` required an
 * EXACT tie, which with 4a wired means two candidates indistinguishable to
 * EVERY scorer, and `SIMILARITY` fires on almost any name pair. So one signal's
 * worth of difference turned "I cannot choose" into "probably this one" —
 * including on `db-02`, the one case the outcome was written for: a single
 * account appearing in two directory connections, both links FRESH, pointing at
 * two DIFFERENT employees. It tied 250/250 at Step 3b and became
 * `SUGGESTED e-100` at 390 vs 250 once 4a ran.
 *
 * Owner decision 2026-10-15: make the rule margin-based, reusing
 * `BULK_MIN_MARGIN`. Measured impact before the change: **exactly one case of
 * 45 moves**, and it moves the engine INTO agreement with a fixture expectation
 * that had been unmet since the corpus was written.
 *
 * WHY THESE TESTS LIVE HERE rather than in `identity-reconcile-precision`: the
 * margin is deliberately NOT an engine invariant. The engine defaults to 0 — an
 * exact tie, what it has always done — and the margin is a STEP 4A POLICY,
 * because a margin is only meaningful against the scorer weights. It is
 * returned by `step4aExtensions`, beside the weights it is derived from, and
 * this is that module's suite.
 */
describe('a thin lead is AMBIGUOUS, not a suggestion (#3560)', () => {
    const NOW = '2026-10-15T00:00:00.000Z';
    const account: CanonicalAccount = { accountKey: 'anwosu', displayName: 'Ada Nwosu' };
    const twin = (id: string): RosterEmployee => ({ id, fullName: 'Ada Nwosu', status: 'ACTIVE' });
    const bothBlock: CandidateBlocker = () => ['e-1', 'e-2'];

    /** Two candidates whose scores differ by exactly `gap`. */
    const withGap = (gap: number, ambiguityMargin?: number) => {
        const scorer: CandidateScorer = (_a, candidate) => [
            {
                kind: 'SIMILARITY',
                score: candidate.id === 'e-1' ? 1000 + gap : 1000,
                evidence: 'synthetic',
            } as SupportingSignal,
        ];
        return reconcile({
            accounts: [account],
            roster: [twin('e-1'), twin('e-2')],
            directory: [],
            aliases: [],
            now: NOW,
            config: {
                blockers: [bothBlock],
                scorers: [scorer],
                ...(ambiguityMargin === undefined ? {} : { ambiguityMargin }),
            },
        }).resolutions[0];
    };

    it('derives the margin from the weights, not from a literal', () => {
        // The whole reason it is returned from `step4aExtensions`: a margin is
        // meaningless except against the scores it is compared to, so it must
        // move when they move. A constant here would go stale the first time
        // anybody re-weighted a scorer.
        const { ambiguityMargin } = step4aExtensions([], null);
        expect(ambiguityMargin).toBe(SCORER_WEIGHTS.CONVENTION);
    });

    it('is the SAME number that bounds bulk confirmation', () => {
        // "Too close to suggest" and "too close to bulk-confirm" are one
        // judgement. Two constants would eventually disagree about it, and the
        // disagreement would be invisible — a row the engine was confident
        // enough to suggest but not confident enough to bulk-confirm reads as
        // a deliberate policy rather than a drifted constant.
        const { ambiguityMargin } = step4aExtensions([], null);
        expect(ambiguityMargin).toBe(BULK_MIN_MARGIN);
    });

    it('defaults to an EXACT tie, so Step 3b is unchanged', () => {
        // Backwards compatibility, asserted rather than assumed. With no margin
        // configured the engine must behave exactly as it did before #3560:
        // only a dead-level tie refuses.
        expect(withGap(0).outcome).toBe('AMBIGUOUS');
        expect(withGap(1).outcome).toBe('SUGGESTED');
        expect(withGap(1000).outcome).toBe('SUGGESTED');
    });

    it('refuses to choose when the lead is thinner than one whole signal', () => {
        const margin = SCORER_WEIGHTS.CONVENTION;
        expect(withGap(1, margin).outcome).toBe('AMBIGUOUS');
        expect(withGap(margin - 1, margin).outcome).toBe('AMBIGUOUS');
        // db-02's actual gap, which is what the decision turned on.
        expect(withGap(140, margin).outcome).toBe('AMBIGUOUS');
    });

    it('suggests at a lead of EXACTLY the margin, matching the bulk bound', () => {
        // STRICT, not `<=`, and the two bounds must agree about their own
        // value: `BULK_MIN_MARGIN` admits a row "ahead by AT LEAST" that much,
        // so a lead of exactly the margin is a suggestion here too. Were this
        // `<=`, there would be a one-point band the engine refuses to suggest
        // and bulk would happily ratify.
        const margin = SCORER_WEIGHTS.CONVENTION;
        expect(withGap(margin, margin).outcome).toBe('SUGGESTED');
        expect(withGap(margin + 1, margin).outcome).toBe('SUGGESTED');
    });

    it('still refuses an exact tie when a margin IS set', () => {
        // The other half of the condition. `gap < margin` alone would be
        // satisfied by a tie too, so this looks redundant — but the
        // implementation is `gap === 0 || gap < margin`, and the first clause is
        // what keeps the default of 0 working. Asserted at both settings so
        // removing either clause fails something.
        expect(withGap(0, SCORER_WEIGHTS.CONVENTION).outcome).toBe('AMBIGUOUS');
        expect(withGap(0, 0).outcome).toBe('AMBIGUOUS');
    });

    it('names no winner when it refuses', () => {
        // A refusal that still filled in `employeeId` would be worse than a
        // suggestion: the UI would show a chosen person on a row whose badge
        // says the engine could not choose.
        const r = withGap(140, SCORER_WEIGHTS.CONVENTION);
        expect(r.outcome).toBe('AMBIGUOUS');
        expect(r.employeeId).toBeNull();
        // And both candidates are still carried, with their evidence.
        expect(r.candidates).toHaveLength(2);
        expect(r.candidates.filter((c) => c.signals.length > 0)).toHaveLength(2);
    });

    it('cannot turn a thin lead into a LINK, however it scores', () => {
        // The invariant the whole supporting-signal design rests on, re-checked
        // at the boundary this change touches: the margin decides between
        // SUGGESTED and AMBIGUOUS and can reach neither LINKED nor UNMATCHED.
        const outcomes = [0, 1, 139, 140, 219, 220, 10_000].map(
            (g) => withGap(g, SCORER_WEIGHTS.CONVENTION).outcome,
        );
        expect(outcomes.filter((o) => o !== 'AMBIGUOUS' && o !== 'SUGGESTED')).toEqual([]);
    });
});

/**
 * Production really does wire what these tests wire (#3560).
 *
 * THREE SUITES CLAIM TO REPLICATE PRODUCTION — this one, the Step 3b precision
 * gate's #3550 block, and the held-out harness — and until now **nothing
 * checked the claim.** Each calls `step4aExtensions` itself and spreads the
 * result into `config`, citing `legacy-reconcile.ts` in a comment. Delete
 * `config: { scorers, blockers, ambiguityMargin }` from the usecase and all
 * three keep passing, measuring a configuration no tenant runs.
 *
 * That is the shape of #3554 exactly: the control-test scheduler's unit test
 * asserted the spelling of a job id against a mocked enqueue, stayed green for
 * seven days, and the thing it described never worked. A harness that
 * reconstructs production is only as good as the assertion that production
 * matches it.
 *
 * STRUCTURAL, because importing the usecase pulls Prisma, the request context
 * and the audit path — and kept to the narrowest possible claim: the three
 * values come out of the extension point and go into the engine's config. The
 * read is MASKED, because this file's own prose names all three.
 */
describe('legacy-reconcile wires the engine the way these tests do (#3560)', () => {
    const usecase = codeOf(
        readFileSync(
            path.resolve(__dirname, '../../src/app-layer/usecases/legacy-reconcile.ts'),
            'utf-8',
        ),
    );

    it('reads CODE, not the comment that explains it', () => {
        // The mask, proved. The usecase carries a long comment of mine naming
        // `ambiguityMargin` and `step4aExtensions` in prose, so an unmasked
        // read would be satisfied by the explanation of the wiring rather than
        // the wiring.
        expect(usecase.length).toBeGreaterThan(1000);
        expect(usecase).not.toContain('probably Jamie Jones');
    });

    it('takes all three values out of step4aExtensions', () => {
        expect(usecase).toContain(
            'const { scorers, blockers, ambiguityMargin } = step4aExtensions(',
        );
    });

    it('puts all three INTO the engine config, which is the half that can rot', () => {
        // Destructuring without passing is the failure this exists for — it
        // compiles, it lints, and the margin silently never reaches the engine.
        // I wrote exactly that bug while making this change, and only noticed
        // by reading the call site back.
        expect(usecase).toContain('config: { scorers, blockers, ambiguityMargin },');
    });

    it('passes the margin to the ONE reconcile call it makes', () => {
        // Counted, so a second `reconcile(` added later cannot be missed: the
        // claim is that every engine run in this usecase carries the config,
        // and a bare count is how that stays true.
        const reconcileCalls = usecase.split('reconcile({').length - 1;
        expect(reconcileCalls).toBe(1);
        expect(usecase.split('ambiguityMargin').length - 1).toBe(2);
    });
});
