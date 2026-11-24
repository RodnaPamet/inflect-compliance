/**
 * `local/no-sub-12px-text` — RuleTester.
 *
 * The `valid` cases carry the weight: an invalid-only suite passes against a
 * rule that flags every `text-[…]`. Each narrowing has a case that goes red if
 * it breaks — the floor itself (12 px, 0.75 rem, 0.76 rem), the named scale,
 * a colour in the same bracket syntax, and a size in a comment.
 *
 * The `invalid` cases cover the spellings the codebase used before the floor
 * (#5924): px and rem, a variant, an arbitrary variant, the important mark, a
 * template literal and a cva/cn argument.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-sub-12px-text');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

const hit = (token: string) => ({ messageId: 'subTwelve', data: { token } });

describe('local/no-sub-12px-text', () => {
    ruleTester.run('no-sub-12px-text', rule, {
        valid: [
            { code: `const a = <p className="text-xs text-content-subtle">x</p>;` },
            { code: `const a = <p className="text-[12px]">x</p>;` },
            { code: `const a = <p className="text-[0.75rem]">x</p>;` },
            { code: `const a = <p className="text-[0.76rem] tracking-[0.005em]">x</p>;` },
            { code: `const a = <p className="text-[13px] md:text-[28px]">x</p>;` },
            { code: `const a = <p className="text-[var(--brand-default)] text-[#fff]">x</p>;` },
            { code: `const a = cn('text-xs', cond && 'sm:text-sm');` },
            // A comment is not a class list.
            { code: `// was text-[10px] before the floor\nconst a = 'text-xs';` },
            // Another unit-less bracket utility.
            { code: `const a = 'tracking-[0.12em] leading-[10px]';` },
        ],
        invalid: [
            {
                code: `const a = <p className="text-[10px] text-content-subtle">x</p>;`,
                errors: [hit('text-[10px]')],
            },
            {
                code: `const a = <p className="uppercase text-[11px]">x</p>;`,
                errors: [hit('text-[11px]')],
            },
            {
                code: `const a = <p className="text-xs md:text-[9px]">x</p>;`,
                errors: [hit('md:text-[9px]')],
            },
            {
                code: `const a = '[&_[cmdk-group-heading]]:text-[10px] font-semibold';`,
                errors: [hit('[&_[cmdk-group-heading]]:text-[10px]')],
            },
            {
                code: `const a = '!text-[10px]';`,
                errors: [hit('!text-[10px]')],
            },
            {
                code: `const a = 'flex size-4 text-[0.625rem]';`,
                errors: [hit('text-[0.625rem]')],
            },
            {
                code: 'const a = `rounded ${tone} text-[11.5px]`;',
                errors: [hit('text-[11.5px]')],
            },
            {
                code: `const v = cva('', { variants: { size: { sm: 'px-1.5 text-[10px] leading-none' } } });`,
                errors: [hit('text-[10px]')],
            },
        ],
    });
});
