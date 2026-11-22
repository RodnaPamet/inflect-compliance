/**
 * `local/shaded-list-rows` — RuleTester.
 *
 * The `valid` cases carry the weight. An invalid-only suite passes against a
 * rule that flags every bordered box, so every narrowing the rule performs gets
 * a case that would go red if it broke:
 *
 *   · the remedy — `<ShadedRow>` — must pass, or people route around the rule;
 *   · a box that carries a STATE (a tone, a hover, a ring, an aria/data
 *     variant) keeps its own tone, which is the owner's exclusion;
 *   · a chip, a pill and a skeleton are not rows;
 *   · a map root inside a `grid` container is a tile, not a row;
 *   · a single box outside any list (a callout) is not a row;
 *   · a class part the rule cannot read may be a tone, so it is left alone;
 *   · a `div` that is not a map root (nested deeper in the callback).
 *
 * The `invalid` cases cover each shape that was live in `src/` before the
 * migration: an `li` root of a row component (the Policy card's version
 * history), an arrow-body map root, a `return` inside a block-bodied callback,
 * a ternary branch, an optional-chained `?.map`, a `cn()` class, a string
 * concatenation with a conditional `opacity-60`, and `border-border-default/50`.
 */
import { RuleTester } from 'eslint';

// CommonJS on purpose — see eslint-rules/index.js for why `.mjs` and `.cjs`
// both fail in this repo.
const rule = require('../rules/shaded-list-rows');

const ruleTester = new RuleTester({
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});

const row = (tone: 'subtle' | 'default') => ({ messageId: 'handRolledRow', data: { tone } });

describe('local/shaded-list-rows', () => {
    ruleTester.run('shaded-list-rows', rule, {
        valid: [
            {
                name: 'the remedy: a ShadedRow returned from a map',
                code: `const a = <ul>{items.map((v) => <ShadedRow as="li" key={v.id}>{v.name}</ShadedRow>)}</ul>;`,
            },
            {
                name: 'a single callout box outside any list is not a row',
                code: `const a = <div className="rounded-lg border border-border-subtle p-4">Notes</div>;`,
            },
            {
                name: 'a row with a hover state keeps its own tone',
                code: `const a = items.map((v) => <div key={v} className="rounded-md border border-border-subtle p-3 hover:border-border-default">{v}</div>);`,
            },
            {
                name: 'a row with a state tone keeps it',
                code: `const a = items.map((v) => <li key={v} className="rounded-lg border border-border-error bg-bg-error p-3">{v}</li>);`,
            },
            {
                name: 'a selected row (emphasis) keeps it, even beside a neutral tone',
                code: `const a = items.map((v) => <div key={v} className={cn('rounded-lg border border-border-subtle p-3', v.on && 'border-border-emphasis')}>{v}</div>);`,
            },
            {
                name: 'a health ring is a state',
                code: `const a = items.map((v) => <div key={v} className="rounded-lg border border-border-subtle p-3 ring-2">{v}</div>);`,
            },
            {
                name: 'an aria variant is a state',
                code: `const a = items.map((v) => <div key={v} className="rounded-lg border border-border-subtle p-3 aria-selected:bg-bg-muted">{v}</div>);`,
            },
            {
                name: 'a chip is not a row',
                code: `const a = <ul>{items.map((v) => <li key={v} className="inline-flex items-center rounded-md border border-border-subtle px-2">{v}</li>)}</ul>;`,
            },
            {
                name: 'a pill is not a row',
                code: `const a = <ul>{items.map((v) => <li key={v} className="rounded-full border border-border-subtle px-2">{v}</li>)}</ul>;`,
            },
            {
                name: 'a skeleton is not a row',
                code: `const a = items.map((v) => <div key={v} className="animate-pulse rounded border border-border-default h-8" />);`,
            },
            {
                name: 'a map root inside a grid is a tile',
                code: `const a = <div className="grid grid-cols-3 gap-default">{items.map((v) => <div key={v} className="rounded-lg border border-border-subtle p-3">{v}</div>)}</div>;`,
            },
            {
                name: 'a class part the rule cannot read may be a tone',
                code: `const a = items.map((v) => <div key={v} className={\`rounded-lg border border-border-subtle p-3 \${TONE[v]}\`}>{v}</div>);`,
            },
            {
                name: 'a box nested inside a map root is not itself the row',
                code: `const a = items.map((v) => <div key={v}><div className="rounded border border-border-subtle p-2">{v}</div></div>);`,
            },
            {
                name: 'a non-map call is not a list',
                code: `const a = items.forEach((v) => <div className="rounded border border-border-subtle p-2">{v}</div>);`,
            },
            {
                name: 'a bordered box with no neutral tone named is not this pattern',
                code: `const a = items.map((v) => <div key={v} className="rounded border p-2">{v}</div>);`,
            },
            {
                name: 'a component, not an intrinsic element',
                code: `const a = items.map((v) => <Card key={v} className="rounded border border-border-subtle p-2">{v}</Card>);`,
            },
            {
                name: 'option-card remedy: a ShadedRow label wrapping a radio',
                code: `const a = opts.map((o) => <ShadedRow as="label" key={o} interactive selected={o === v}><RadioGroupItem value={o} />{o}</ShadedRow>);`,
            },
            {
                name: 'a label that IS the control (no padding) is not an option card',
                code: `const a = <label className={cn('flex h-5 w-5 rounded border border-border-default bg-bg-default', on && 'border-[var(--brand-default)]')}><input type="checkbox" className="sr-only" /></label>;`,
            },
            {
                name: 'a boxed label wrapping no radio or checkbox is not an option card',
                code: `const a = <label className="rounded-lg border border-border-subtle p-3"><input type="text" /></label>;`,
            },
            {
                name: 'an option pill (rounded-full) is not a card',
                code: `const a = <label className="rounded-full border border-border-subtle px-2"><input type="checkbox" /></label>;`,
            },
        ],
        invalid: [
            {
                name: 'option card: a label wrapping a RadioGroupItem, with its own selected / hover branches',
                code: "const a = opts.map((o) => <label key={o} className={`flex rounded-lg border p-3 cursor-pointer ${o === v ? 'border-border-emphasis bg-bg-subtle' : 'border-border-subtle hover:bg-bg-muted'}`}><RadioGroupItem value={o} />{o}</label>);",
                errors: [{ messageId: 'handRolledOption' }],
            },
            {
                name: 'option card: a single label wrapping a Checkbox, brand selected tone',
                code: "const a = <label className={`p-3 rounded-lg border ${on ? 'border-[var(--brand-default)] bg-[var(--brand-subtle)]' : 'border-border-default hover:border-border-emphasis'}`}><Checkbox checked={on} /></label>;",
                errors: [{ messageId: 'handRolledOption' }],
            },
            {
                name: 'option card: a map-root div wrapping a native radio, with a hover state',
                code: `const a = opts.map((o) => <div key={o} className="flex rounded-md border border-border-subtle p-3 hover:border-border-default"><input type="radio" />{o}</div>);`,
                errors: [{ messageId: 'handRolledOption' }],
            },
            {
                name: 'an li root of a row component — the Policy card version history',
                code: `function VersionRow() { return <li className="rounded-lg border border-border-subtle p-3 space-y-tight">v1</li>; }`,
                errors: [row('subtle')],
            },
            {
                name: 'an arrow-body map root',
                code: `const a = <div className="space-y-tight">{items.map((v) => (<div key={v} className="rounded-lg border border-border-subtle p-3">{v}</div>))}</div>;`,
                errors: [row('subtle')],
            },
            {
                name: 'a return inside a block-bodied callback',
                code: `const a = items.map((v) => { const x = v; if (x) { return <section key={v} className="space-y-compact rounded-lg border border-border-subtle p-5">{x}</section>; } return null; });`,
                errors: [row('subtle')],
            },
            {
                name: 'a ternary branch of a map callback',
                code: `const a = items.map((v) => v.ok ? <div key={v} className="rounded-md border border-border-subtle p-4">{v}</div> : null);`,
                errors: [row('subtle')],
            },
            {
                name: 'an optional-chained ?.map with a translucent default tone',
                code: `const a = items?.map((v) => <div key={v} className="p-3 border border-border-default/50 rounded-lg mb-2">{v}</div>);`,
                errors: [row('default')],
            },
            {
                name: 'a cn() class',
                code: `const a = items.map((v) => <article key={v} className={cn('rounded border border-border-subtle', 'p-2')}>{v}</article>);`,
                errors: [row('subtle')],
            },
            {
                name: 'a concatenation with a conditional dimming class',
                code: `const a = items.map((v) => <div key={v} className={'rounded-lg border border-border-subtle p-3 ' + (v.na ? 'opacity-60' : '')}>{v}</div>);`,
                errors: [row('subtle')],
            },
            {
                name: 'an li anywhere, an arbitrary radius',
                code: `const a = <ul><li className="flex rounded-[8px] border border-border-subtle px-default py-2">x</li></ul>;`,
                errors: [row('subtle')],
            },
        ],
    });
});
