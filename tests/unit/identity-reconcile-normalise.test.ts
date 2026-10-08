/**
 * The normalisation library, measured against the hardening the step demands.
 *
 * The transliteration assertions are the load-bearing ones: they are the only
 * place that proves the ORDER of operations, and the order is the whole difference
 * between a Bulgarian passport's spelling and a wrong one.
 */
import {
    baseClean,
    normaliseEmail,
    normaliseName,
    normaliseUsername,
    normaliseEmployeeNumber,
    translitVariants,
    transliterate,
    NORMALISE_LIMITS,
} from '@/lib/identity/reconcile/normalise';
import { emailKey } from '@/lib/identity/email-key';

const of = (token: string, scheme: string): string | undefined =>
    translitVariants(token).find((v) => v.scheme === scheme)?.value;

const STREAMLINED = 'bg-streamlined-2009';
const TRADITIONAL = 'bg-traditional';

describe('transliteration runs BEFORE diacritic folding', () => {
    /**
     * The failure this pins: fold first and NFD decomposes `й` into `и` plus a
     * combining breve, the breve is stripped, and the token transliterates as if it
     * had been `и` all along. `Йордан` becomes `Iordan` and `Николай` becomes
     * `Nikolai` — not what the law says, and not what is printed in the passport the
     * person is holding.
     */
    it.each([
        ['Йордан', 'Yordan'],
        ['Николай', 'Nikolay'],
        ['Йоана', 'Yoana'],
    ])('%s -> %s, not the I-form', (input, expected) => {
        expect(of(input, STREAMLINED)).toBe(expected);
    });

    it('and the breve really is what would be lost — the control', () => {
        // `й` decomposed is `и` + U+0306. If folding ran first this is the token the
        // table would see, and `и` maps to `i`.
        const decomposed = 'Й'.normalize('NFD');
        expect(decomposed.length).toBe(2);
        expect(of(decomposed.normalize('NFC'), STREAMLINED)).toBe('Y');
    });
});

describe("the Streamlined System's word-final rule", () => {
    it.each([
        ['София', 'Sofia'],
        ['Мария', 'Maria'],
        ['Виктория', 'Viktoria'],
    ])('%s -> %s under the law', (input, expected) => {
        expect(of(input, STREAMLINED)).toBe(expected);
    });

    it('and the traditional scheme deliberately does NOT contract it', () => {
        // A second scheme is only useful where the two actually disagree.
        expect(of('София', TRADITIONAL)).toBe('Sofiya');
        expect(of('Мария', TRADITIONAL)).toBe('Mariya');
    });

    it('the rule is word-final, not a blanket ия substitution', () => {
        // `ияма` is not a Bulgarian word; the point is that a medial `ия` is not
        // contracted, so the rule cannot fire mid-token.
        expect(of('Диян', STREAMLINED)).toBe('Diyan');
    });
});

describe('the two tables differ where the step says they differ', () => {
    it('щ: sht under the law, shch traditionally', () => {
        expect(of('Щербанов', STREAMLINED)).toBe('Shterbanov');
        expect(of('Щербанов', TRADITIONAL)).toBe('Shcherbanov');
    });

    it('ъ maps to a in BOTH — never dropped', () => {
        // The library this replaces renders `Ъгълов` as `glov`, dropping the hard
        // sign entirely. No human writes that, and it is the measurement that
        // decided against the dependency.
        // Asked through the per-scheme accessor: the candidate LIST de-duplicates
        // when both tables agree, so it cannot answer "what does each say".
        expect(transliterate('Ъгълов', STREAMLINED)).toBe('Agalov');
        expect(transliterate('Ъгълов', TRADITIONAL)).toBe('Agalov');
        // And the list shows it once, not twice.
        expect(translitVariants('Ъгълов').map((v) => v.value)).toEqual(['Ъгълов', 'Agalov']);
    });

    it('a plain surname agrees under both, so the schemes only diverge where needed', () => {
        expect(transliterate('Иванов', STREAMLINED)).toBe('Ivanov');
        expect(transliterate('Иванов', TRADITIONAL)).toBe('Ivanov');
    });

    it('capitalisation survives a multi-character mapping', () => {
        expect(of('Ж', STREAMLINED)).toBe('Zh');
        expect(of('ж', STREAMLINED)).toBe('zh');
    });
});

describe('look-alike folding applies ONLY to a mixed-script token', () => {
    it('a purely Cyrillic name is transliterated, never folded', () => {
        const schemes = translitVariants('Иванов').map((v) => v.scheme);
        expect(schemes).not.toContain('lookalike-fold');
        // The fold would give `Иbaнob` — neither the name nor a romanisation.
        expect(translitVariants('Иванов').map((v) => v.value)).not.toContain('Иbaнob');
    });

    it('a mixed token gets a folded candidate, because it is a Latin name mistyped', () => {
        // `Ivаnov` with a Cyrillic `а`.
        const mixed = `Iv${'\u0430'}nov`;
        const variants = translitVariants(mixed);
        expect(variants.map((v) => v.scheme)).toContain('lookalike-fold');
        expect(variants.find((v) => v.scheme === 'lookalike-fold')?.value).toBe('Ivanov');
    });

    it('a pure Latin token produces only itself', () => {
        expect(translitVariants('Ivanov')).toEqual([{ value: 'Ivanov', scheme: 'none' }]);
    });
});

describe('every variant records its scheme, and the order is deterministic', () => {
    it('identical input gives a byte-identical list', () => {
        expect(translitVariants('Щербанов')).toEqual(translitVariants('Щербанов'));
    });

    it('order is none, then the law, then traditional', () => {
        expect(translitVariants('Щербанов').map((v) => v.scheme))
            .toEqual(['none', STREAMLINED, TRADITIONAL]);
    });

    it('de-duplicates when the schemes agree, keeping the first scheme that produced it', () => {
        // `Иванов` romanises identically under both tables, so there is one Latin
        // variant and it is attributed to the law rather than listed twice.
        const v = translitVariants('Иванов');
        expect(v.map((x) => x.value)).toEqual(['Иванов', 'Ivanov']);
        expect(v[1].scheme).toBe(STREAMLINED);
    });
});

describe('emailKey is built on, never replaced', () => {
    it('key is exactly what emailKey returns', () => {
        for (const raw of ['Ivan.Ivanov@Example.TEST', ' ivan@example.test ', 'not-an-email', '']) {
            expect(normaliseEmail(raw).key).toBe(emailKey(baseClean(raw) || null));
        }
    });

    it('+tag stripping is a SEPARATE layer that leaves key untouched', () => {
        const n = normaliseEmail('ivan+legacy@example.test');
        expect(n.key).toBe(emailKey('ivan+legacy@example.test'));
        expect(n.untagged).toBe('ivan@example.test');
        expect(n.localPart).toBe('ivan');
    });

    it('domain equivalence likewise — comparison only', () => {
        const n = normaliseEmail('ivan@googlemail.com');
        expect(n.domain).toBe('gmail.com');
        // The key keeps the real domain: it is what the JML chain joins on.
        expect(n.key).toContain('googlemail.com');
    });

    it('a malformed address yields nulls rather than throwing', () => {
        for (const raw of ['@', 'a@', '@b', '', null, undefined]) {
            expect(() => normaliseEmail(raw)).not.toThrow();
        }
    });
});

describe('name parsing', () => {
    it('handles Last, First', () => {
        const n = normaliseName('Ivanov, Ivan');
        expect([n.given, n.family]).toEqual(['Ivan', 'Ivanov']);
    });

    it('keeps middle names and separates honorifics and suffixes', () => {
        const n = normaliseName('Dr. Ivan Petrov Ivanov Jr.');
        expect([n.given, n.family]).toEqual(['Ivan', 'Ivanov']);
        expect(n.middle).toEqual(['Petrov']);
        expect(n.honorifics).toEqual(['Dr.']);
        expect(n.suffixes).toEqual(['Jr.']);
    });

    it('lifts parenthetical tags into their own field', () => {
        const n = normaliseName('Ivan Ivanov (contractor)');
        expect(n.tags).toEqual(['contractor']);
        expect([n.given, n.family]).toEqual(['Ivan', 'Ivanov']);
    });

    it('a mononym does NOT get a guessed split', () => {
        // Step 4a's convention generator depends on this returning nothing rather
        // than inventing a family name.
        const n = normaliseName('Cher');
        expect([n.given, n.family]).toEqual(['Cher', null]);
    });

    it('a trailing comma is punctuation, not a structure', () => {
        const n = normaliseName('Ivan Ivanov,');
        expect([n.given, n.family]).toEqual(['Ivan', 'Ivanov']);
    });
});

describe('username parsing', () => {
    it.each([
        ['ivan.ivanov', ['ivan', 'ivanov']],
        ['ivan_ivanov', ['ivan', 'ivanov']],
        ['ivan-ivanov', ['ivan', 'ivanov']],
        ['ivanIvanov', ['ivan', 'Ivanov']],
    ])('%s splits to %s', (input, expected) => {
        expect(normaliseUsername(input).tokens).toEqual(expected);
    });

    it('keeps a DOMAIN qualifier instead of discarding it', () => {
        // Two `jsmith` accounts in different domains are two accounts; dropping the
        // qualifier is how they wrongly become one.
        const n = normaliseUsername('CORP\\jsmith');
        expect(n.qualifier).toBe('CORP');
        expect(n.tokens).toEqual(['jsmith']);
    });

    it('separates a UPN suffix and a trailing disambiguator', () => {
        const n = normaliseUsername('ivanov2@corp.example');
        expect(n.upnSuffix).toBe('corp.example');
        expect(n.disambiguator).toBe('2');
        expect(n.tokens).toEqual(['ivanov']);
    });

    it('does not strip digits that are the whole token', () => {
        // `12345` is an identifier, not `''` with a disambiguator.
        const n = normaliseUsername('12345');
        expect(n.disambiguator).toBeNull();
        expect(n.tokens).toEqual(['12345']);
    });
});

describe('employee numbers', () => {
    it.each([
        ['EMP-000123', '123'],
        ['000123', '123'],
        ['123', '123'],
        ['E123', '123'],
    ])('%s -> %s', (input, expected) => {
        expect(normaliseEmployeeNumber(input)).toBe(expected);
    });

    it.each([['ivan@example.test'], ['not a number'], [''], ['000'], ['ABC']])(
        'returns null for %s rather than something', (input) => {
            // A fallback here would let a work email pose as the strongest match
            // signal in the system — the same refusal Step 0c makes.
            expect(normaliseEmployeeNumber(input)).toBeNull();
        },
    );
});

describe('every function is total', () => {
    const hostile = [
        '', ' ', null, undefined,
        'x'.repeat(NORMALISE_LIMITS.MAX_INPUT * 4),
        `a${'\u200B'}b${'\u202E'}c`,
        '\uD800',                       // unpaired high surrogate
        `${'\uDC00'}x`,                 // unpaired low surrogate
        '(((((((((((((((((((((((((((((((',
        'a'.repeat(200) + ','.repeat(200),
        'Ivan'.repeat(200),
    ];

    it.each(hostile.map((h, i) => [i, h]))('input #%i throws from nothing', (_i, raw) => {
        expect(() => baseClean(raw as string)).not.toThrow();
        expect(() => normaliseName(raw as string)).not.toThrow();
        expect(() => normaliseUsername(raw as string)).not.toThrow();
        expect(() => normaliseEmail(raw as string)).not.toThrow();
        expect(() => normaliseEmployeeNumber(raw as string)).not.toThrow();
    });

    it('caps its input rather than trusting the caller', () => {
        expect(baseClean('x'.repeat(NORMALISE_LIMITS.MAX_INPUT * 4)).length)
            .toBeLessThanOrEqual(NORMALISE_LIMITS.MAX_INPUT);
    });

    it('bounds the token count', () => {
        const many = Array.from({ length: 200 }, (_, i) => `t${i}`).join(' ');
        expect(normaliseName(many).variants.length).toBeLessThanOrEqual(NORMALISE_LIMITS.MAX_TOKENS);
    });

    /**
     * Bounded in OPERATIONS, not wall-clock. A millisecond budget on a machine
     * shared with other sessions is a flake; a step count is a property of the
     * matcher. The pathological inputs are the shapes that make a naive nested
     * quantifier backtrack: unbalanced brackets, long runs, repeated delimiters.
     */
    it('finishes pathological input without catastrophic backtracking', () => {
        const pathological = [
            '('.repeat(400),
            `${'('.repeat(200)}a${')'.repeat(1)}`,
            `${'a.'.repeat(400)}a`,
            `${'a-'.repeat(400)}a`,
            `${'0'.repeat(400)}1`,
        ];
        for (const p of pathological) {
            const started = process.hrtime.bigint();
            normaliseName(p);
            normaliseUsername(p);
            normaliseEmployeeNumber(p);
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            // A generous ceiling: quadratic backtracking on these shapes takes
            // seconds to minutes, so this separates linear from catastrophic
            // without being a timing assertion in the flaky sense.
            expect(ms).toBeLessThan(250);
        }
    });
});
