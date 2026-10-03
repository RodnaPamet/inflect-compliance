/**
 * Guard — every class-keyed rule in a GLOBAL stylesheet lives inside a
 * `@layer`.
 *
 * THE DEFECT THIS CLOSES
 * ──────────────────────
 * In Tailwind v4 an UNLAYERED rule beats a layered one at equal specificity
 * regardless of source order, and v4 emits every generated utility inside
 * `@layer utilities`. So an unlayered `.foo { padding: … }` in a global
 * stylesheet silently swallows every `className` utility that touches the
 * same property.
 *
 * It is invisible to every assertion anyone naturally writes. The class is
 * present either way; the element renders; only the COMPUTED value differs.
 * A class-name assertion, a snapshot of the markup, an RTL
 * `toHaveClass('pr-10')` — all green. That is why `src/app/globals.css`
 * carried the defect for the whole life of the file and shipped it on eight
 * separate recipes:
 *
 *   #3119/#3143 — found it on `.glass-card`, measured in headless Chromium
 *                 (`glass-card p-12` → padding 16px, not 48px), fixed that
 *                 one rule and left the class of defect open. Before that PR
 *                 `globals.css` contained ZERO `@layer` blocks: `.glass-card`
 *                 was not special, it was the one instance somebody measured.
 *   #3153       — layered the other eight recipes, deleted the dead `.btn`
 *                 family, and added THIS guard, because the thing that stops
 *                 the next recipe landing unlayered is a check, not a fixed
 *                 instance.
 *
 * Cascade layers are compared BEFORE specificity, which is why this guard has
 * to reach descendant rules too: `.data-table td` is (0,1,1) and was beating
 * a (0,1,0) utility twice over — on layer AND on specificity.
 *
 * WHY THIS IS A GUARD AND NOT AN ESLINT RULE
 * ──────────────────────────────────────────
 * `eslint-rules/README.md` says to prefer an AST rule for a structural
 * invariant. This one is about CSS, and the repo's eslint config has no CSS
 * parser wired in; the subject here is a postcss AST, parsed with the same
 * `postcss` the app build uses, so it is not a regex over source text either.
 *
 * SCOPE: "class-keyed"
 * ───────────────────
 * A rule is in scope when the LEADING compound of one of its selectors
 * contains a class — `.input`, `select.input`, `.data-table td`,
 * `.policy-content > :first-child`. Those are the rules a `className` on the
 * element composes against.
 *
 * Out of scope, and deliberately so:
 *   - `body`, `html`, `:root`, `::-webkit-scrollbar`, `@page` — no class, so
 *     no `className` can be written next to them.
 *   - `[data-process-canvas="true"] .react-flow__edge` — the leading compound
 *     is an ATTRIBUTE selector. The classes further right are emitted by
 *     xyflow, not written at a call site, so nothing composes against them.
 *   - `*.module.css` — a CSS Module's class names are hashed and reached as
 *     `styles.card`; they are never written in a `className` string beside a
 *     Tailwind utility. `src/app/global-error.module.css` is additionally
 *     self-contained on purpose (it must render when the main app CSS fails).
 */
import * as fs from 'fs';
import { parse } from 'postcss';
import type { Container, Node } from 'postcss';
import { repoFiles, repoRelative } from '../helpers/repo-files';

/**
 * A rule that may stay unlayered, with the reason it may.
 *
 * `selector` and `atRules` must match an UNLAYERED class-keyed rule that is
 * actually present. An entry matching nothing is a HOLE — the rule it
 * described has moved, been layered, or been deleted, and the exemption now
 * excuses whatever lands at that selector next — so a stale entry FAILS
 * (see "no stale exemptions" below).
 */
interface Exemption {
    file: string;
    selector: string;
    /** Enclosing conditional at-rules, outermost first, `@name params`. */
    atRules: readonly string[];
    reason: string;
}

const EXEMPTIONS: readonly Exemption[] = [
    {
        file: 'src/app/globals.css',
        selector: '.input',
        atRules: ['@media (pointer: coarse)'],
        reason:
            'A FLOOR, not a default. WCAG 2.5.5 / Apple HIG minimum touch target ' +
            '(44px) for native inputs on coarse pointers. #3143\'s argument for ' +
            'layering — "the recipe is the default, className overrides it" — is an ' +
            'argument about defaults; this is the one declaration on `.input` that ' +
            'must not lose to a drive-by utility, because layered a `min-h-8` would ' +
            'silently shrink a finger target. Measured when the exemption was ' +
            'written: zero of the 96 `.input` call sites pass a `min-h-*`/`max-h-*` ' +
            'utility, so layering it would change nothing today — the choice is ' +
            'purely about which FUTURE change may win. Its neighbours in the same ' +
            '`@media (pointer: coarse)` block are the `[role="checkbox"]` / ' +
            '`[role="radio"]` / `[role="switch"]` hit-target expansions: the same ' +
            'accessibility decision, attribute-keyed and so already out of scope. ' +
            'Counter-argument on record: the repo\'s own canonical spelling of this ' +
            'floor is `pointer-coarse:min-h-11` in the `<Input>` cva, which IS ' +
            'overridable. If that consistency wins, layer the rule and delete this ' +
            'entry in the same diff.',
    },
];

/**
 * Selectors that MUST be found in scope, whatever their layer. A positive
 * control on the real file: if the selector walk, the leading-compound test or
 * the file population silently stops working, the in-scope set empties and
 * every "no violations" assertion passes vacuously. These make that loud.
 */
const MUST_BE_IN_SCOPE: readonly string[] = [
    '.glass-card',
    '.input',
    'select.input',
    'textarea.input',
    '.input-label',
    '.data-table td',
    '.data-table tr:hover td',
    '.animate-fadeIn',
    '.icon-btn:focus-visible',
    '.surface-popup-texture',
    '.policy-content h2',
    '.no-print',
];

/**
 * A loose floor on the population, for the same reason. Deliberately far
 * below the real count (~60) so that no routine PR — and no concurrent PR —
 * has any reason to touch this line; it only has to be high enough that an
 * empty or near-empty read cannot pass.
 */
const MIN_IN_SCOPE_RULES = 20;

interface ScannedRule {
    file: string;
    selector: string;
    selectors: readonly string[];
    atRules: readonly string[];
    /** `null` when the rule sits outside every `@layer`. */
    layer: string | null;
    line: number;
}

/**
 * Split a selector into its top-level compounds and return the first one.
 * Combinators are ` `, `>`, `+`, `~`; brackets and parens are not descended
 * into, so `[data-x="a b"]` and `:not(.x .y)` stay one token.
 */
export function leadingCompound(selector: string): string {
    let depth = 0;
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (c === '[' || c === '(') depth++;
        else if (c === ']' || c === ')') depth--;
        else if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === '>' || c === '+' || c === '~')) {
            return selector.slice(0, i);
        }
    }
    return selector;
}

/** Does this compound select on a class the author could write in `className`? */
export function isClassKeyed(selector: string): boolean {
    const head = leadingCompound(selector.trim());
    // `.foo`, `select.foo`, `.foo:hover`, `.foo.bar` — but not `\.` escapes,
    // which cannot occur in a hand-written global stylesheet in this repo.
    return /(^|[^\\])\.[a-zA-Z_-][\w-]*/.test(head);
}

/** Walk up for the nearest enclosing `@layer`, plus the conditional at-rules. */
function enclosing(node: Node): { layer: string | null; atRules: string[] } {
    let layer: string | null = null;
    const atRules: string[] = [];
    let p: Container | undefined = node.parent as Container | undefined;
    while (p) {
        if (p.type === 'atrule') {
            const at = p as Container & { name: string; params: string };
            if (at.name === 'layer') {
                if (layer === null) layer = at.params.trim() || '(anonymous)';
            } else {
                atRules.unshift(`@${at.name}${at.params ? ' ' + at.params : ''}`);
            }
        }
        p = p.parent as Container | undefined;
    }
    return { layer, atRules };
}

/** Every class-keyed rule in one stylesheet's text. */
export function collectClassKeyedRules(css: string, file: string): ScannedRule[] {
    const out: ScannedRule[] = [];
    parse(css, { from: file }).walkRules((rule) => {
        const selectors = rule.selectors ?? [];
        if (!selectors.some(isClassKeyed)) return;
        const { layer, atRules } = enclosing(rule);
        out.push({
            file,
            selector: rule.selector.replace(/\s+/g, ' ').trim(),
            selectors,
            atRules,
            layer,
            line: rule.source?.start?.line ?? 0,
        });
    });
    return out;
}

/** The global (non-module) stylesheets under `src/`, as git defines them. */
function globalStylesheets(): string[] {
    return repoFiles({ under: 'src', extensions: ['.css'] }).filter(
        (abs) => !abs.endsWith('.module.css'),
    );
}

const SCANNED: ScannedRule[] = globalStylesheets().flatMap((abs) =>
    collectClassKeyedRules(fs.readFileSync(abs, 'utf-8'), repoRelative(abs)),
);

const matchesExemption = (r: ScannedRule, e: Exemption): boolean =>
    r.file === e.file &&
    r.selector === e.selector &&
    r.atRules.length === e.atRules.length &&
    r.atRules.every((a, i) => a === e.atRules[i]);

const UNLAYERED = SCANNED.filter((r) => r.layer === null);

describe('global stylesheets — every class-keyed rule is inside a @layer', () => {
    it('reads a real population (the collector is not empty)', () => {
        // Guards against the silent-zero failure: a changed file layout, a
        // parse that returns nothing, or a leading-compound test that stops
        // recognising classes would otherwise make every assertion below pass
        // by having nothing to check.
        expect(globalStylesheets().map(repoRelative)).toContain('src/app/globals.css');
        expect(SCANNED.length).toBeGreaterThanOrEqual(MIN_IN_SCOPE_RULES);
    });

    it.each(MUST_BE_IN_SCOPE)('classifies `%s` as class-keyed', (selector) => {
        const found = SCANNED.filter((r) => r.selectors.includes(selector));
        expect(found.length).toBeGreaterThan(0);
    });

    it('no class-keyed rule sits outside a @layer without a written exemption', () => {
        const violations = UNLAYERED.filter(
            (r) => !EXEMPTIONS.some((e) => matchesExemption(r, e)),
        );
        const detail = violations
            .map(
                (r) =>
                    `  ${r.file}:${r.line}  ${r.atRules.join(' / ')}${r.atRules.length ? '  ' : ''}${r.selector}`,
            )
            .join('\n');
        expect(
            violations.length === 0 ? '' : detail,
        ).toBe('');
    });

    it('no stale exemptions (an exemption for a rule that no longer exists is a hole)', () => {
        const stale = EXEMPTIONS.filter(
            (e) => !UNLAYERED.some((r) => matchesExemption(r, e)),
        );
        expect(
            stale.map((e) => `${e.file}: ${e.atRules.join(' / ')} ${e.selector}`),
        ).toEqual([]);
    });

    it('every exemption carries a substantive written reason', () => {
        for (const e of EXEMPTIONS) {
            expect(e.reason.trim().length).toBeGreaterThan(80);
        }
    });

    describe('the detector has teeth (discriminating pair, independent of the real file)', () => {
        // A guard whose collector can read empty passes vacuously, and a
        // detector that returns the same answer in both worlds is zero
        // evidence. These run the REAL functions over synthetic CSS where the
        // right answer is known, so the pair discriminates.
        const FIXTURE = `
            :root { --x: 1px; }
            body { margin: 0; }
            ::-webkit-scrollbar { width: 6px; }
            .unlayered-recipe { padding: 1rem; }
            select.unlayered-typed { appearance: none; }
            @layer components { .layered-recipe { padding: 1rem; } }
            @layer components { .layered-parent td { padding: 1rem; } }
            [data-canvas="true"] .vendor-class { cursor: pointer; }
            @media print { .unlayered-in-media { display: none !important; } }
            @media (pointer: coarse) { .unlayered-in-coarse { min-height: 44px; } }
        `;
        const rules = collectClassKeyedRules(FIXTURE, 'fixture.css');
        const sel = (s: string) => rules.find((r) => r.selector === s);

        it('POSITIVE — flags an unlayered class rule', () => {
            expect(sel('.unlayered-recipe')?.layer).toBeNull();
        });

        it('POSITIVE — flags an unlayered element+class rule', () => {
            expect(sel('select.unlayered-typed')?.layer).toBeNull();
        });

        it('POSITIVE — flags an unlayered class rule nested in @media, and records the condition', () => {
            expect(sel('.unlayered-in-media')?.layer).toBeNull();
            expect(sel('.unlayered-in-media')?.atRules).toEqual(['@media print']);
            expect(sel('.unlayered-in-coarse')?.atRules).toEqual(['@media (pointer: coarse)']);
        });

        it('NEGATIVE — a layered class rule is in scope but not a violation', () => {
            expect(sel('.layered-recipe')?.layer).toBe('components');
            expect(sel('.layered-parent td')?.layer).toBe('components');
        });

        it('NEGATIVE — rules with no class in the leading compound are not in scope at all', () => {
            const selectors = rules.map((r) => r.selector);
            expect(selectors).not.toContain('body');
            expect(selectors).not.toContain(':root');
            expect(selectors).not.toContain('::-webkit-scrollbar');
            expect(selectors).not.toContain('[data-canvas="true"] .vendor-class');
        });

        it('leadingCompound stops at the first top-level combinator only', () => {
            expect(leadingCompound('.a .b')).toBe('.a');
            expect(leadingCompound('.a>.b')).toBe('.a');
            expect(leadingCompound('.policy-content > :first-child')).toBe('.policy-content');
            // A bracket or paren must NOT be treated as a combinator boundary.
            expect(leadingCompound('[data-x="a b"] .c')).toBe('[data-x="a b"]');
            expect(leadingCompound(':not(.a .b) .c')).toBe(':not(.a .b)');
        });

        it('isClassKeyed answers on the LEADING compound, not anywhere in the selector', () => {
            expect(isClassKeyed('.input')).toBe(true);
            expect(isClassKeyed('select.input')).toBe(true);
            expect(isClassKeyed('.data-table tr:hover td')).toBe(true);
            expect(isClassKeyed('body')).toBe(false);
            expect(isClassKeyed('[data-process-canvas="true"] .react-flow__edge')).toBe(false);
            expect(isClassKeyed('[data-x] .y.z')).toBe(false);
        });
    });
});
