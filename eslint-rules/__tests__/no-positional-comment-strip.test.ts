/**
 * `local/no-positional-comment-strip` (#4659).
 *
 * The invalid cases are the spellings that were in `tests/` before #4659
 * migrated them, one of each. The valid cases are the regexes that look
 * similar and delete no code: removing a docblock's markers, matching a
 * single `//` with no repeat after it, a URL credential redaction, and a
 * comment that only QUOTES the pattern.
 */
import { RuleTester } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';

import rule from '../rules/no-positional-comment-strip';

const ruleTester = new RuleTester({
    languageOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
    },
});

const block = { messageId: 'positional', data: { what: 'block', opener: '/*' } };
const line = { messageId: 'positional', data: { what: 'line', opener: '//' } };

describe('local/no-positional-comment-strip', () => {
    ruleTester.run('no-positional-comment-strip', rule, {
        valid: [
            {
                name: 'the shared masker',
                code: `import { codeOf } from '../helpers/source-blocks'; const c = codeOf(src);`,
            },
            {
                name: "removing a docblock's markers deletes no code",
                code: `const text = doc.replace(/\\/\\*\\*|\\*\\/|\\*/g, '');`,
            },
            {
                name: 'a single // with nothing repeated after it',
                code: `const isProtocolRelative = /^\\/\\//.test(href);`,
            },
            {
                name: 'a comment that quotes the pattern is not a regex',
                code: `// the old strip was /\\/\\*[\\s\\S]*?\\*\\//g\nconst x = 1;`,
            },
            {
                name: 'matching code that may carry a comment line deletes nothing',
                code: `expect(src).toMatch(/'A',\\s*(?:\\/\\/[^\\n]*\\n\\s*)?'B',/);`,
            },
            {
                name: 'matching an empty catch with an optional comment deletes nothing',
                code: `expect(src).not.toMatch(/\\.catch\\(\\s*\\(\\)\\s*=>\\s*\\{\\s*(\\/\\*[^*]*\\*\\/\\s*)?\\}\\s*\\)/);`,
            },
            {
                name: 'a strip regex held in a variable is not seen (stated limit)',
                code: `const STRIP = /\\/\\/[^\\n]*/g; const c = src.replace(STRIP, '');`,
            },
            {
                name: 'the pattern inside a string is not a regex literal',
                code: `const fixture = "src.replace(/\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\//g, '')";`,
            },
        ],
        invalid: [
            {
                name: 'the block strip, lazy [\\s\\S]',
                code: `const c = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '');`,
                errors: [block],
            },
            {
                name: 'the block strip, [^] and blanking replacement',
                code: `const c = src.replace(/\\/\\*[^]*?\\*\\//g, ' ');`,
                errors: [block],
            },
            {
                name: 'the block strip, dot with the s flag',
                code: `const c = src.replace(/\\/\\*.*?\\*\\//gs, '');`,
                errors: [block],
            },
            {
                name: 'the line strip, [^\\n]*',
                code: `const c = src.replace(/\\/\\/[^\\n]*/g, '');`,
                errors: [line],
            },
            {
                name: 'the line strip, .*$ multiline',
                code: `const c = src.replace(/\\/\\/.*$/gm, '');`,
                errors: [line],
            },
            {
                name: 'the line strip anchored at line start',
                code: `const c = src.replace(/^\\s*\\/\\/.*$/gm, '');`,
                errors: [line],
            },
            {
                name: 'the URL-aware attempt is still positional',
                code: `const c = src.replace(/(^|[^:])\\/\\/[^\\n]*/g, '$1');`,
                errors: [line],
            },
            {
                name: 'triple-slash variant',
                code: `const c = src.replace(/^\\s*\\/\\/\\/?.*$/gm, '');`,
                errors: [line],
            },
            {
                name: 'both halves of the chain are reported',
                code: `const c = src.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/\\/\\/[^\\n]*/g, '');`,
                errors: [block, line],
            },
            {
                name: 'replaceAll is a strip too',
                code: `const c = src.replaceAll(/\\/\\/[^\\n]*/g, '');`,
                errors: [line],
            },
            {
                name: 'the leading-comment strip before a directive',
                code: `const head = src.replace(/^(?:\\s*(?:\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)\\s*)*/, '');`,
                errors: [block],
            },
            {
                name: 'per-line strip inside a map',
                code: `const ls = src.split('\\n').map((l) => l.replace(/\\/\\/.*$/, '').trim());`,
                errors: [line],
            },
        ],
    });
});
