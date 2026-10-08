/**
 * `local/no-brand-focus-indicator` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every class with "brand" in it, so every narrowing the rule
 * performs gets a case that would go red if it broke:
 *
 *   · the remedy — focus utilities reading `--accent-default` /
 *     `--accent-emphasis` — must pass, or people route around the rule;
 *   · the ring tokens a host already controls (`--ring`, `ring-ring`,
 *     `ring-focus-ring`, `--ctrl-edge-focus`) are not brand reads;
 *   · a brand ring with NO focus variant (a selected card, a KPI glow) is brand
 *     decoration, which a host is meant to recolour with its brand;
 *   · a focus utility that is not an indicator (`focus-visible:bg-…`,
 *     `focus:text-brand-…`) is out of scope — the rule polices the ring, the
 *     halo, the outline and the border;
 *   · `focus-visible:ring-2` and `ring-offset-2` — numbers, not colours;
 *   · prose that merely contains the words, in a string that is not a class;
 *   · a comment quoting a banned class, which an AST never visits.
 *
 * The `invalid` cases cover each shape that was live in `src/components/ui`
 * before the accent seam: the Button's two-stop halo, the `/40` row rings, the
 * named palette utility (`ring-brand-default`, `ring-brand-emphasis`), plus a
 * template-literal quasi, a stacked and a `group-` variant, a leading and a
 * trailing `!`, a border, an outline and a raw palette shade.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-brand-focus-indicator');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

const brandFocus = (cls: string) => ({ messageId: 'brandFocus', data: { cls } });

describe('local/no-brand-focus-indicator', () => {
    ruleTester.run('no-brand-focus-indicator', rule, {
        valid: [
            {
                name: 'the remedy: the Button halo reads the accent',
                code: `const c = "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--accent-default)]";`,
            },
            {
                name: 'an accent ring is not a brand read, whatever its alpha (alpha is no-translucent-focus-indicator)',
                code: `const c = cn("focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]/40");`,
            },
            {
                name: 'the remedy: the emphasis accent',
                code: `const c = "focus-visible:ring-[var(--accent-emphasis)] focus-visible:ring-offset-2";`,
            },
            {
                name: 'the ring tokens a host already controls',
                code: `const c = "focus-visible:ring-[var(--ring)] focus-visible:ring-ring focus-visible:ring-focus-ring focus-visible:shadow-[var(--ctrl-edge-focus)]";`,
            },
            {
                name: 'a brand ring with no focus variant is decoration, not a pointer',
                code: `const c = "ring-2 ring-brand-default border-border-emphasis shadow-[inset_2px_0_0_var(--brand-default)]";`,
            },
            {
                name: 'a hover or selected brand edge is not a focus indicator',
                code: `const c = "hover:border-[var(--brand-default)] data-[selected=true]:ring-[var(--brand-default)]";`,
            },
            {
                name: 'a focus utility that is not an indicator is out of scope',
                code: `const c = "focus-visible:bg-[var(--brand-subtle)] focus:text-content-brand";`,
            },
            {
                name: 'numbers are widths and offsets, not colours',
                code: `const c = "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-default";`,
            },
            {
                name: 'prose with the words in it is not a class',
                code: `const m = "Give the focus ring a brand colour: ring-brand is not a utility here";`,
            },
            {
                name: 'a comment quoting the banned class is never visited',
                code: `// focus-visible:ring-[var(--brand-default)]/40 was the old ring\nconst c = "focus-visible:ring-[var(--accent-default)]/40";`,
            },
            {
                name: 'JSX className reading the accent',
                code: `const e = <button className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]" />;`,
            },
        ],
        invalid: [
            {
                name: "the Button's two-stop halo naming the brand",
                code: `const c = "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--brand-default)]";`,
                errors: [brandFocus('focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--brand-default)]')],
            },
            {
                name: 'a row ring at 40% naming the brand',
                code: `const c = cn("focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)]/40");`,
                errors: [brandFocus('focus-visible:ring-[var(--brand-default)]/40')],
            },
            {
                name: 'the named palette utility',
                code: `const c = "focus-visible:ring-2 focus-visible:ring-brand-default focus-visible:ring-offset-2";`,
                errors: [brandFocus('focus-visible:ring-brand-default')],
            },
            {
                name: 'the emphasis brand, as the undo toast had it',
                code: `const c = "focus-visible:ring-brand-emphasis focus-visible:ring-offset-2";`,
                errors: [brandFocus('focus-visible:ring-brand-emphasis')],
            },
            {
                name: 'a raw palette shade on plain focus',
                code: `const e = <input className="text-brand-500 focus:ring-brand-500" />;`,
                errors: [brandFocus('focus:ring-brand-500')],
            },
            {
                name: 'inside a template literal quasi',
                code: 'const c = `flex ${extra} focus-visible:ring-[var(--brand-default)] rounded-md`;',
                errors: [brandFocus('focus-visible:ring-[var(--brand-default)]')],
            },
            {
                name: 'stacked and group- variants',
                code: `const c = "md:focus-visible:outline-[var(--brand-default)] group-focus-visible:border-brand-emphasis";`,
                errors: [
                    brandFocus('md:focus-visible:outline-[var(--brand-default)]'),
                    brandFocus('group-focus-visible:border-brand-emphasis'),
                ],
            },
            {
                name: 'important, leading and trailing',
                code: `const c = "focus-visible:!ring-brand-default focus-visible:shadow-[0_0_0_4px_var(--brand-muted)]!";`,
                errors: [
                    brandFocus('focus-visible:!ring-brand-default'),
                    brandFocus('focus-visible:shadow-[0_0_0_4px_var(--brand-muted)]!'),
                ],
            },
            {
                name: 'focus-within on a border side',
                code: `const c = "focus-within:border-b-[var(--brand-default)]";`,
                errors: [brandFocus('focus-within:border-b-[var(--brand-default)]')],
            },
        ],
    });
});
