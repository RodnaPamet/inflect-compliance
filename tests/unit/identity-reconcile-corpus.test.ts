/**
 * The corpus checks itself, and the normalisation library against it.
 *
 * A fixture set is only as good as the claims it makes about its own coverage. A
 * corpus that silently lost its Cyrillic cases would still pass a test that looped
 * over whatever remained — so the categories are declared, asserted exhaustive in
 * both directions, and the population is printed.
 */
import {
    CORPUS,
    CORPUS_CATEGORIES,
    type CorpusCase,
    type Outcome,
} from '../fixtures/identity-reconcile/corpus';
import {
    normaliseEmail,
    normaliseName,
    normaliseUsername,
    normaliseEmployeeNumber,
    DOMAIN_EQUIVALENCE,
} from '@/lib/identity/reconcile/normalise';

const byId = (id: string): CorpusCase => {
    const c = CORPUS.find((x) => x.id === id);
    if (!c) throw new Error(`no corpus case ${id}`);
    return c;
};

describe('the corpus describes itself accurately', () => {
    it('has cases, and prints its population', () => {
        console.log(`corpus: ${CORPUS.length} cases across ${CORPUS_CATEGORIES.length} categories`);
        expect(CORPUS.length).toBeGreaterThanOrEqual(20);
    });

    it('every id is unique', () => {
        const ids = CORPUS.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every declared category has at least one case', () => {
        const used = new Set(CORPUS.map((c) => c.category));
        expect(CORPUS_CATEGORIES.filter((c) => !used.has(c))).toEqual([]);
    });

    it('and no case uses a category outside the declared list', () => {
        // The other direction. Without it a typo'd category would be invisible:
        // the forward check passes as long as the declared ones are covered.
        const declared = new Set<string>(CORPUS_CATEGORIES);
        expect(CORPUS.filter((c) => !declared.has(c.category)).map((c) => c.id)).toEqual([]);
    });

    it('every case says what it is for', () => {
        expect(CORPUS.filter((c) => !c.why || c.why.length < 20).map((c) => c.id)).toEqual([]);
    });

    it('every expected employee exists in that case own HR slice', () => {
        const dangling = CORPUS.filter(
            (c) => c.expected.employeeId !== null && !c.hr.some((h) => h.id === c.expected.employeeId),
        ).map((c) => c.id);
        expect(dangling).toEqual([]);
    });

    it('and every case with no expected employee expects an outcome that permits none', () => {
        const permitted: Outcome[] = ['AMBIGUOUS', 'UNMATCHED', 'NON_PERSON'];
        const bad = CORPUS.filter((c) => c.expected.employeeId === null && !permitted.includes(c.expected.outcome));
        expect(bad.map((c) => c.id)).toEqual([]);
    });
});

describe('the corpus is synthetic, and its header says so', () => {
    const ADDRESS_RE = /[\w.+-]+@[\w.-]+/g;

    it('every address is under a reserved domain', () => {
        const addresses: string[] = [];
        for (const c of CORPUS) {
            for (const v of [c.account.email, ...c.hr.map((h) => h.workEmail), ...c.directory.map((d) => d.email)]) {
                if (v) addresses.push(...(v.match(ADDRESS_RE) ?? []));
            }
        }
        expect(addresses.length).toBeGreaterThan(0);
        /*
            Reserved domains, OR one of the exact domains DOMAIN_EQUIVALENCE exists
            to equate. An alias pair cannot be demonstrated with reserved domains —
            the real pair IS the data under test — so rather than waive the rule,
            the permission is pinned to the table: add a domain the table does not
            know and this fails.
        */
        const aliasDomains = new Set([
            ...Object.keys(DOMAIN_EQUIVALENCE),
            ...Object.values(DOMAIN_EQUIVALENCE),
        ]);
        const offending = addresses.filter((a) => {
            if (/@([\w-]+\.)*example\.(test|invalid)$/.test(a)) return false;
            const domain = a.slice(a.lastIndexOf('@') + 1).toLowerCase();
            if (!aliasDomains.has(domain)) return true;
            // Permitted only with a local part that cannot be anybody's mailbox.
            return !a.toLowerCase().startsWith('zz-corpus-');
        });
        expect(offending).toEqual([]);
    });

    it('carries no employee number that looks like a national identifier', () => {
        // A Bulgarian EGN is 10 digits; the corpus uses 4.
        const long = CORPUS.flatMap((c) => c.hr).filter((h) => (h.employeeNumber ?? '').length >= 9);
        expect(long).toEqual([]);
    });
});

describe('transliteration and similarity never reach LINKED in the corpus', () => {
    /**
     * This encodes the rule rather than describing it. Only a strong deterministic
     * signal may produce LINKED; a Cyrillic or mixed-script case resting on a
     * romanisation is SUGGESTED at most. A corpus that expected LINKED here would
     * be setting Step 3b a target that contradicts the design.
     */
    it.each(['cyrillic-streamlined', 'cyrillic-traditional', 'mixed-script'])(
        '%s cases expect at most SUGGESTED', (category) => {
            const linked = CORPUS.filter((c) => c.category === category && c.expected.outcome === 'LINKED');
            expect(linked.map((c) => c.id)).toEqual([]);
        },
    );

    it('while the corpus does contain LINKED cases, so the bar is not vacuous', () => {
        // Without this, "no Cyrillic case is LINKED" would also pass on a corpus
        // where nothing at all was LINKED.
        const linked = CORPUS.filter((c) => c.expected.outcome === 'LINKED');
        expect(linked.length).toBeGreaterThanOrEqual(2);
        // And each rests on a strong signal: an exact email, a real employee
        // number, or a fresh unique directory bridge.
        for (const c of linked) {
            const strong =
                c.hr.some((h) => h.workEmail && h.workEmail === c.account.email)
                || c.hr.some((h) => h.employeeNumber && normaliseEmployeeNumber(c.account.accountKey) === h.employeeNumber)
                || c.directory.filter((d) => d.linkFresh && d.samAccountName === c.account.accountKey).length === 1;
            expect({ id: c.id, strong }).toEqual({ id: c.id, strong: true });
        }
    });
});

describe('the library produces the normal forms the corpus records', () => {
    const withForms = CORPUS.filter((c) => c.normalForms);

    it('there are cases to check', () => {
        expect(withForms.length).toBeGreaterThanOrEqual(15);
    });

    it.each(withForms.map((c) => [c.id, c]))('%s', (_id, c) => {
        const f = (c as CorpusCase).normalForms!;
        const acct = (c as CorpusCase).account;

        if (f.emailKey !== undefined) expect(normaliseEmail(acct.email).key).toBe(f.emailKey);
        if (f.emailUntagged !== undefined) expect(normaliseEmail(acct.email).untagged).toBe(f.emailUntagged);

        if (f.nameGiven !== undefined || f.nameFamily !== undefined) {
            const n = normaliseName(acct.displayName);
            if (f.nameGiven !== undefined) expect(n.given).toBe(f.nameGiven);
            if (f.nameFamily !== undefined) expect(n.family).toBe(f.nameFamily);
        }

        if (f.usernameTokens !== undefined) {
            expect(normaliseUsername(acct.accountKey).tokens).toEqual([...f.usernameTokens]);
        }

        if (f.employeeNumber !== undefined) {
            expect(normaliseEmployeeNumber(acct.accountKey)).toBe(f.employeeNumber);
        }

        if (f.translitContains !== undefined) {
            // Every recorded romanisation must appear among SOME token's variants.
            const all = normaliseName(acct.displayName).variants.flat().map((v) => v.value);
            const alsoUsername = normaliseUsername(acct.accountKey).variants.flat().map((v) => v.value);
            const pool = new Set([...all, ...alsoUsername]);
            for (const expected of f.translitContains) expect([...pool]).toContain(expected);
        }
    });
});

describe('the pathological cases are bounded', () => {
    const pathological = CORPUS.filter((c) => c.category === 'pathological-input');

    it('there are some', () => {
        expect(pathological.length).toBeGreaterThanOrEqual(3);
    });

    it('and the library finishes all of them without catastrophic backtracking', () => {
        const started = process.hrtime.bigint();
        for (const c of pathological) {
            normaliseName(c.account.displayName);
            normaliseUsername(c.account.accountKey);
            normaliseEmail(c.account.email);
            normaliseEmployeeNumber(c.account.accountKey);
        }
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        // Separating linear from catastrophic, not asserting a performance budget:
        // quadratic backtracking on these shapes takes seconds, not milliseconds.
        expect(ms).toBeLessThan(500);
    });
});
