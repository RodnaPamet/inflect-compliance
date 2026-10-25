/**
 * `local/regex-within-ts-target` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every regex, so every narrowing gets a case that would go
 * red if it broke:
 *
 *   · the remedy, `[\s\S]`, and the ES2015 flags `u`, `y`, `g`, `i`, `m`;
 *   · lookbehind and `\p{…}`, ES2018 syntax that tsc ACCEPTS at ES2017;
 *   · `(?<` that is not a group: escaped, inside a class, after an escaped paren;
 *   · a pattern built at run time, which tsc does not check either;
 *   · every flagged form at a target high enough to allow it.
 *
 * The `invalid` cases are the four constructs tsc refuses at ES2017, measured
 * against tsc 5.9 (TS1501 for the flags, TS1503 for named groups).
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/regex-within-ts-target');

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
});

const at2017 = [{ target: 2017 }];
const REMEDY: Record<string, string> = { s: ' Write `[\\s\\S]` where the pattern means any character.' };
const flag = (f: string, needed: number, target = 2017) => ({
    messageId: 'flag',
    data: { flag: f, needed, target, remedy: REMEDY[f] ?? '' },
});
const namedGroup = { messageId: 'namedGroup', data: { needed: 2018, target: 2017 } };

describe('local/regex-within-ts-target', () => {
    ruleTester.run('regex-within-ts-target', rule, {
        valid: [
            { code: 'const a = /a[\\s\\S]*b/;', options: at2017 },
            { code: 'const a = /a/gimuy;', options: at2017 },
            { code: 'const a = /(?<=a)b/;', options: at2017 },
            { code: 'const a = /(?<!a)b/;', options: at2017 },
            { code: 'const a = /\\p{L}/u;', options: at2017 },
            { code: 'const a = /\\(?<x/;', options: at2017 },
            { code: 'const a = /[(?<x]/;', options: at2017 },
            { code: 'const a = /\\\\(?=<x)/;', options: at2017 },
            { code: 'const a = /(a)(?:b)\\1/;', options: at2017 },
            { code: "const a = new RegExp('(?<y>x)', 's');", options: at2017 },
            { code: "const a = '(?<y>x)';", options: at2017 },
            { code: 'const a = /a.b/s;', options: [{ target: 2018 }] },
            { code: 'const a = /(?<y>x)/;', options: [{ target: 2018 }] },
            { code: 'const a = /a/d;', options: [{ target: 2022 }] },
            { code: 'const a = /[a]/v;', options: [{ target: 2024 }] },
        ],
        invalid: [
            { code: 'const a = /a.b/s;', options: at2017, errors: [flag('s', 2018)] },
            { code: 'const a = /a/d;', options: at2017, errors: [flag('d', 2022)] },
            { code: 'const a = /[a]/v;', options: at2017, errors: [flag('v', 2024)] },
            { code: 'const a = /(?<year>\\d{4})/;', options: at2017, errors: [namedGroup] },
            { code: 'const a = /\\\\(?<year>\\d)/;', options: at2017, errors: [namedGroup] },
            { code: 'const a = /[x](?<y>x)/;', options: at2017, errors: [namedGroup] },
            {
                code: 'const a = /(?<k>a).b/s;',
                options: at2017,
                errors: [flag('s', 2018), namedGroup],
            },
            { code: 'const a = /a/d;', options: [{ target: 2018 }], errors: [flag('d', 2022, 2018)] },
            { code: 'expect(src).toMatch(/a.b/s);', options: at2017, errors: [flag('s', 2018)] },
        ],
    });
});
