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
    type CanonicalAccount,
    type RosterEmployee,
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
    step4aExtensions,
    SCORER_WEIGHTS,
} from '@/lib/identity/reconcile/scorers';
import { CORPUS } from '../fixtures/identity-reconcile/corpus';

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
                accounts: [c.account as CanonicalAccount],
                roster,
                directory: c.directory as never,
                aliases: [],
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
