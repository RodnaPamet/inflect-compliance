/**
 * `local/no-literal-aria-label` — RuleTester.
 *
 * The `valid` cases carry the narrowing: the remedy (a translated name) must
 * pass, and so must a computed value and a literal with no letter in it. The
 * `invalid` cases cover each spelling of a literal, and a non-Latin one: a
 * Bulgarian literal is as wrong on an English page as the reverse.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js.
const rule = require('../rules/no-literal-aria-label');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

describe('local/no-literal-aria-label', () => {
    ruleTester.run('no-literal-aria-label', rule, {
        valid: [
            {
                name: 'the remedy: a name from the translator',
                code: `const a = <DatePicker aria-label={tx('new.nextReviewLabel')} />;`,
            },
            {
                name: 'a computed name',
                code: `const a = <button aria-label={label ? t('a', { label }) : t('b')} />;`,
            },
            {
                name: 'a template with an expression is computed',
                code: 'const a = <button aria-label={`${t("open")} ${name}`} />;',
            },
            {
                name: 'a literal with no letter names nothing in a language',
                code: `const a = <span aria-label="—" />;`,
            },
            {
                name: 'another attribute is not an accessible name',
                code: `const a = <div data-testid="Next review date" />;`,
            },
        ],
        invalid: [
            {
                name: 'a quoted English literal',
                code: `const a = <DatePicker aria-label="Next review date" />;`,
                errors: [{ messageId: 'literal' }],
            },
            {
                name: 'a string in braces',
                code: `const a = <nav aria-label={'Table of contents'} />;`,
                errors: [{ messageId: 'literal' }],
            },
            {
                name: 'a template literal with no expression',
                code: 'const a = <nav aria-label={`Table of contents`} />;',
                errors: [{ messageId: 'literal' }],
            },
            {
                name: 'a Bulgarian literal',
                code: `const a = <nav aria-label="Съдържание" />;`,
                errors: [{ messageId: 'literal' }],
            },
        ],
    });
});
