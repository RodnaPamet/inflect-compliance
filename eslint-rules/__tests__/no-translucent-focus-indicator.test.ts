/**
 * `local/no-translucent-focus-indicator` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every `/` in a class string, so every narrowing the rule
 * performs gets a case that would go red if it broke:
 *
 *   · the remedy, a SOLID accent ring, and the solid Button halo;
 *   · widths and offsets (`ring-2`, `ring-offset-2`, `outline-offset-2`), which
 *     are numbers, not colours;
 *   · an opacity modifier WITHOUT a focus variant (`hover:bg-bg-muted/50`, a
 *     decorative `ring-brand-default/40`) — out of scope, this polices focus;
 *   · a focus utility that is not an indicator (`focus-visible:bg-bg-muted/50`);
 *   · alpha INSIDE an arbitrary value, which the rule documents it cannot see;
 *   · a comment quoting the banned form.
 *
 * The `invalid` cases are the three row rings this rule was written for, in
 * the exact form they shipped, plus the named-colour and bracketed-alpha
 * shapes, a template quasi, and stacked / `group-` / `!` variants.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/no-translucent-focus-indicator');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

const translucent = (cls: string) => ({ messageId: 'translucentFocus', data: { cls } });

describe('local/no-translucent-focus-indicator', () => {
    ruleTester.run('no-translucent-focus-indicator', rule, {
        valid: [
            {
                name: 'the remedy: a solid accent ring',
                code: `const c = "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]";`,
            },
            {
                name: 'the solid Button halo',
                code: `const c = "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--accent-default)]";`,
            },
            {
                name: 'widths and offsets are numbers, not colours',
                code: `const c = "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-offset-2 focus-visible:ring-offset-bg-default";`,
            },
            {
                name: 'an opacity modifier with no focus variant is out of scope',
                code: `const c = "hover:bg-bg-muted/50 ring-2 ring-brand-default/40";`,
            },
            {
                name: 'a focus utility that is not an indicator is out of scope',
                code: `const c = "focus-visible:bg-bg-muted/50 focus:text-content-muted/80";`,
            },
            {
                name: 'alpha inside an arbitrary value is a value decision the rule does not judge',
                code: `const c = "focus-visible:shadow-[0_0_0_3px_rgb(220_38_38_/_0.20)]";`,
            },
            {
                name: 'a comment quoting the banned form is never visited',
                code: `// focus-visible:ring-[var(--accent-default)]/40 was the old ring\nconst c = "focus-visible:ring-[var(--accent-default)]";`,
            },
        ],
        invalid: [
            {
                name: 'the table region ring as it shipped',
                code: `const c = cn("focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]/40");`,
                errors: [translucent('focus-visible:ring-[var(--accent-default)]/40')],
            },
            {
                name: 'the mobile card ring, inside JSX',
                code: `const e = <div className="cursor-pointer hover:bg-bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-default)]/40" />;`,
                errors: [translucent('focus-visible:ring-[var(--accent-default)]/40')],
            },
            {
                name: 'a named colour with a modifier',
                code: `const c = "focus-visible:ring-border-error/50";`,
                errors: [translucent('focus-visible:ring-border-error/50')],
            },
            {
                name: 'a bracketed alpha modifier',
                code: `const c = "focus-visible:outline-[var(--ring)]/[0.4]";`,
                errors: [translucent('focus-visible:outline-[var(--ring)]/[0.4]')],
            },
            {
                name: 'inside a template literal quasi',
                code: 'const c = `flex ${extra} focus-visible:ring-[var(--accent-default)]/40 rounded-md`;',
                errors: [translucent('focus-visible:ring-[var(--accent-default)]/40')],
            },
            {
                name: 'stacked, group- and important variants',
                code: `const c = "md:focus-visible:border-[var(--accent-default)]/60 group-focus-visible:ring-accent/30 focus-visible:!ring-[var(--ring)]/50";`,
                errors: [
                    translucent('md:focus-visible:border-[var(--accent-default)]/60'),
                    translucent('group-focus-visible:ring-accent/30'),
                    translucent('focus-visible:!ring-[var(--ring)]/50'),
                ],
            },
        ],
    });
});
