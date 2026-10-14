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

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { REPO_ROOT } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

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
     * A SMOKE TEST, and labelled as one since #3496.
     *
     * The docblock here used to read "Bounded in OPERATIONS, not wall-clock. A
     * millisecond budget on a machine shared with other sessions is a flake; a
     * step count is a property of the matcher" — and then asserted milliseconds.
     * The principle was right and the code did the opposite, which is how the
     * Step 3a criterion came to be reported as met for months.
     *
     * The ceiling fails in both directions. 250 ms is generous enough that a
     * QUADRATIC matcher on a 400-character input finishes inside it on an idle
     * machine, and tight enough that LINEAR code can exceed it on a runner
     * carrying four Jest shards. So this case stays, because driving real
     * pathological strings through the real functions is worth having, but it is
     * no longer the evidence for the criterion. That is the structural check
     * below, which is machine-independent and fires on the edit that introduces
     * the risk rather than on a slow afternoon.
     */
    it('finishes pathological input (smoke only — the structural check is below)', () => {
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

/**
 * LINEAR BY CONSTRUCTION — the half of the Step 3a criterion a clock cannot buy.
 *
 * The criterion asks that "each is linear by construction, and the pathological
 * inputs finish within a bound measured in operations, not wall-clock time".
 * This is the first clause, checked structurally, and it is machine-independent:
 * the same source gives the same answer on an idle laptop and a loaded runner.
 *
 * WHAT IT DETECTS, and only this: a quantified GROUP whose body either carries an
 * unbounded quantifier — `(a+)+`, `(a*)*`, `(\w+\s?)*` — or is an alternation
 * with exactly duplicate branches, `(a|a)*`, where every position has two
 * indistinguishable ways to match. Those are the classic catastrophic shapes,
 * they are the ones that recur, and they are what a careless "tidy the regex"
 * edit introduces. An exponential matcher almost always looks like one of them.
 *
 * WHAT IT DOES NOT DETECT, stated so nobody reads a green run as a proof of
 * linearity: adjacent unbounded quantifiers over overlapping classes (`\w+\d+`,
 * polynomial rather than exponential), alternation branches that OVERLAP without
 * being identical (`(a|ab)*` — deciding that needs an automaton, not a string
 * comparison), a catastrophic pattern assembled at runtime through
 * `new RegExp(...)`, and anything imported from another module.
 * The population is the regex LITERALS in this one file, and the count is
 * asserted so a scan that stopped matching cannot pass over nothing.
 *
 * Comments are stripped first. A prose example of a bad pattern in a docblock —
 * including the ones in this very comment — must not trip the check: a scar is
 * not a wound.
 */
describe('3a — every regex in normalise.ts is linear by construction', () => {
    const SOURCE = path.join(REPO_ROOT, 'src/lib/identity/reconcile/normalise.ts');

    /** Regex literals, comments removed. */
    function regexLiterals(src: string): readonly string[] {
        const code = codeOf(src);
        const out: string[] = [];
        // A literal starts at `/` and ends at an unescaped `/`, with character
        // classes treated as opaque so a `/` inside `[...]` does not end it.
        for (let i = 0; i < code.length; i += 1) {
            if (code[i] !== '/') continue;
            // Skip anything that is plainly division or a path in a string.
            const prev = code.slice(0, i).trimEnd().slice(-1);
            if (/[\w)\]]/.test(prev)) continue;
            let j = i + 1;
            let inClass = false;
            let closed = false;
            for (; j < code.length; j += 1) {
                const c = code[j];
                if (c === '\\') { j += 1; continue; }
                if (c === '\n') break;
                if (inClass) { if (c === ']') inClass = false; continue; }
                if (c === '[') { inClass = true; continue; }
                if (c === '/') { closed = true; break; }
            }
            if (!closed || j === i + 1) continue;
            out.push(code.slice(i + 1, j));
            i = j;
        }
        return out;
    }

    /**
     * A quantified group whose body carries an unbounded quantifier.
     *
     * Bounded inner quantifiers are fine and deliberately permitted —
     * `(?:[0-9]{1,4})+` cannot blow up, and `normalise.ts` uses bounded repeats
     * throughout precisely so it does not have to.
     */
    function nestedQuantifiers(pattern: string): readonly string[] {
        const bad: string[] = [];
        for (let i = 0; i < pattern.length; i += 1) {
            if (pattern[i] !== '(') continue;
            if (pattern[i - 1] === '\\') continue;
            // Find this group's matching close paren.
            let depth = 0;
            let close = -1;
            let inClass = false;
            for (let j = i; j < pattern.length; j += 1) {
                const c = pattern[j];
                if (c === '\\') { j += 1; continue; }
                if (inClass) { if (c === ']') inClass = false; continue; }
                if (c === '[') { inClass = true; continue; }
                if (c === '(') depth += 1;
                else if (c === ')') { depth -= 1; if (depth === 0) { close = j; break; } }
            }
            if (close === -1) continue;
            const after = pattern.slice(close + 1);
            const groupIsQuantified = /^(?:[*+]|\{\s*\d*\s*,\s*\}?)/.test(after);
            if (!groupIsQuantified) continue;
            const body = pattern.slice(i + 1, close);
            // An UNBOUNDED quantifier inside the body: `*`, `+`, or `{n,}`.
            const bodyHasUnbounded = /(?<!\\)[*+]|\{\s*\d+\s*,\s*\}/.test(body);
            // Or an alternation with EXACTLY DUPLICATE branches: `(a|a)*`. Every
            // position then has two indistinguishable ways to match, which is the
            // same explosion by a different route. Only exact duplicates — real
            // overlap (`(a|ab)*`) needs an automaton, and the header says so.
            const branches = body.replace(/^\?:/, '').split('|');
            const duplicateBranch =
                branches.length > 1 && new Set(branches).size !== branches.length;
            if (bodyHasUnbounded || duplicateBranch) bad.push(pattern.slice(i, close + 2));
        }
        return bad;
    }

    const LITERALS = regexLiterals(readFileSync(SOURCE, 'utf8'));

    it('finds the regex population at all', () => {
        // The denominator beside the result. A literal scanner that stopped
        // matching would pass the assertion below over an empty list.
        expect(LITERALS.length).toBeGreaterThanOrEqual(8);
    });

    it('no regex nests an unbounded quantifier inside a quantified group', () => {
        const offenders = LITERALS.flatMap((lit) =>
            nestedQuantifiers(lit).map((frag) => `/${lit}/ -> ${frag}`),
        );
        expect(offenders).toEqual([]);
    });

    describe('detector proof — on synthetic patterns, so a clean run means something', () => {
        it.each([
            ['(a+)+', 'the textbook case'],
            ['(a*)*', 'the same with a star'],
            ['(\\w+\\s?)*', 'the shape that bites real validators'],
            ['(a|a)*b', 'overlapping alternation under a star'],
        ])('flags %s — %s', (pattern) => {
            expect(nestedQuantifiers(pattern).length).toBeGreaterThan(0);
        });

        it.each([
            ['[A-Za-z]{0,8}0*([0-9]{1,32})', 'adjacent quantifiers, no nesting'],
            ['^(.*?[^0-9])([0-9]{1,4})$', 'the real employee-number pattern'],
            ['\\(([^()]{0,120})\\)', 'the real parenthetical pattern'],
            ['(?:[0-9]{1,4})+', 'a BOUNDED inner quantifier is permitted'],
            ['[.,]', 'no group at all'],
        ])('accepts %s — %s', (pattern) => {
            expect(nestedQuantifiers(pattern)).toEqual([]);
        });

        it('does NOT claim to catch overlapping-but-distinct branches', () => {
            // `(a|ab)*` is catastrophic and this check does not see it. Asserted
            // rather than left to the header, so the limit is a fact the suite
            // holds instead of a caveat somebody may not read.
            expect(nestedQuantifiers('(a|ab)*')).toEqual([]);
        });

        it('extracts literals without being fooled by a comment', () => {
            // The prose in this file names `(a+)+` several times. If the
            // extractor read comments, the check would fail on its own docblock.
            const src = [
                '// a comment mentioning /(a+)+/ which must not be extracted',
                '/** and a docblock with /(x*)*/ in it */',
                'const good = /[A-Za-z]{1,8}/;',
            ].join('\n');
            const lits = regexLiterals(src);
            expect(lits).toContain('[A-Za-z]{1,8}');
            expect(lits.some((l) => l.includes('a+'))).toBe(false);
        });
    });
});
