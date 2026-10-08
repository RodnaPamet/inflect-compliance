/**
 * Guardrail: CVA primitive components — Button, StatusBadge, EmptyState
 *
 * Verifies that the three foundational primitives:
 * 1. Export the expected API surface
 * 2. Use semantic design tokens (not raw neutral/gray/white)
 * 3. Have consistent variant definitions
 * 4. Back every variant with the token system from tokens.css
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';

// ROOT-relative CONSTANT paths, one per call site (#3046).
//
// The primitives are migrating to `@inflect/ui` a batch at a time, and during
// a batch `src/components/ui/<name>` holds a 13-line `export * from …` shim
// rather than the implementation. So the paths below have to change when a
// file moves — but HOW they are written matters as much as where they point.
//
// WHY NOT A RESOLVER. The obvious fix is a helper that tries
// `packages/ui/...` then falls back to `src/...`. I wrote that first and
// MEASURED it: `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts`
// fell from 1175 to 1158, and a per-site diff put all seventeen lost sites in
// THIS FILE. The Class D analyser follows a read only to a CONSTANT path
// (`tests/helpers/assertion-reach.ts` resolveSubject); a path returned from a
// loop over candidate roots is `path-not-constant`, so every assertion here
// silently left the analysed population. The suite still passed. It simply
// stopped being measured — which is the failure mode that ratchet exists to
// catch, introduced by the act of fixing a different one.
//
// That ratchet's own docblock already prescribes this shape, from #3046 step
// 3a: a read "rewritten from `path.join(<variable dir>, 'index.ts')` to
// `path.join(ROOT, '<literal path>')` while being taught to scan two roots,
// and a constant path is what the analyser follows." A literal per call site
// is more verbose than a resolver and is the point.
const ROOT = path.resolve(__dirname, '../../');

function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

/** Moved to `@inflect/ui` in #3046 batch 3a — `src/` holds a re-export shim. */
const BUTTON = 'packages/ui/src/components/ui/button.tsx';
const BUTTON_VARIANTS = 'packages/ui/src/components/ui/button-variants.ts';
const EMPTY_STATE = 'packages/ui/src/components/ui/empty-state.tsx';
/** NOT moved: a 149-line implementation that merely imports `@inflect/ui/lib/cn`. */
const STATUS_BADGE = 'src/components/ui/status-badge.tsx';

const RAW_LIGHT_COLOR_REGEX =
    /(?:neutral|gray|white|slate)-(?:50|100|200|300|400|950)\b/;

describe('the paths above point at implementations, not shims (#3046)', () => {
    // Every assertion in this file is a whole-file `toMatch`/`toContain`. Point
    // one at a 13-line re-export shim and it fails with "expected
    // /export const buttonVariants/" — a message about the needle, when the
    // defect is the path. This test fails FIRST and says which constant is
    // wrong, so the next person who moves a primitive gets a sentence instead
    // of a hunt.
    //
    // `toBe(false)` on a boolean rather than `not.toMatch(…)` on the file text,
    // deliberately: a whole-file matcher here would join the Class D population
    // that `assertion-needle-uniqueness-ratchet` measures, and this file's
    // contribution to that count is load-bearing at exactly 17. A boolean
    // comparison is invisible to it.
    const SHIM = /export \* from '@inflect\/ui/;
    for (const [name, rel] of [
        ['BUTTON', BUTTON],
        ['BUTTON_VARIANTS', BUTTON_VARIANTS],
        ['EMPTY_STATE', EMPTY_STATE],
        ['STATUS_BADGE', STATUS_BADGE],
    ] as const) {
        it(`${name} (${rel}) is an implementation`, () => {
            const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            expect(SHIM.test(raw)).toBe(false);
            // And not merely absent-of-shim: a path typo that resolved to some
            // other small file would also pass the negative above.
            expect(raw.length).toBeGreaterThan(400);
        });
    }
});

describe('Button primitive', () => {
    const src = read(BUTTON);
    const variantsSrc = read(BUTTON_VARIANTS);

    it('exports buttonVariants and Button', () => {
        expect(variantsSrc).toMatch(/export const buttonVariants/);
        expect(src).toMatch(/export \{ Button \}/);
    });

    it('defines expected variant keys (post v2-PR-1 cull)', () => {
        // v2-PR-1 retired `outline` (→ secondary), `success` (→ primary),
        // and renamed `danger` → `destructive`. The Still Surface cull
        // (2026-07-28) then folded `destructive-outline` → `destructive`,
        // leaving the canonical FOUR.
        for (const v of ['primary', 'secondary', 'ghost', 'destructive']) {
            expect(variantsSrc).toContain(`${v}:`);
        }
        expect(variantsSrc).not.toContain(`"destructive-outline":`);
    });

    it('defines size variants', () => {
        for (const s of ['xs', 'sm', 'md', 'lg']) {
            expect(variantsSrc).toContain(`${s}:`);
        }
    });

    it('uses semantic tokens for primary variant', () => {
        // Primary button uses CSS variable-based brand colors for theme
        // compatibility. 2026-05-31: the fill is the brand→secondary
        // gradient token `--btn-gradient-primary` (theme-aware, defined
        // from `--brand-default` in tokens.css), replacing the prior
        // flat `--btn-glass-fill-primary` + `--brand-default` hover.
        // Still Surface (2026-07-28): the primary fill is a static
        // gradient built from the brand stops directly rather than the
        // pre-baked `--btn-gradient-primary` token.
        // Narrowed from the bare token names `/--brand-default/` and
        // `/--brand-emphasis/` (#3084). Those matched anywhere in the file, and
        // once the tile classes were written out literally instead of being
        // built by `stillTile()`, each had 5+ satisfying positions and crossed
        // `HIGH_MULTIPLICITY` in `assertion-needle-uniqueness-ratchet` — a
        // Class D ratchet with zero drift allowance, fired by a diff that did
        // not touch this file. The ratchet was right: a bare token name says
        // "this string appears somewhere", which is not what this test means.
        //
        // These two pin the constructs that carry the intent — the DEEP stop as
        // the base fill, and the brand ramp as the gradient — so the assertion
        // now fails if the fill stops being a semantic token rather than merely
        // if the token name disappears from the file.
        expect(variantsSrc).toMatch(/"bg-\[var\(--brand-emphasis\)\]"/);
        expect(variantsSrc).toMatch(
            /linear-gradient\(to_bottom,var\(--brand-default\),var\(--brand-emphasis\)\)/,
        );
    });

    it('uses semantic tokens for secondary variant', () => {
        // Still Surface (2026-07-28): secondary is a surface tile built
        // from `--bg-default` → `--bg-muted`, so the token now appears
        // inside a `bg-[image:…]` gradient rather than as the bare
        // `bg-bg-default` utility. The intent of this test ("semantic
        // tokens, no hex literals") is unchanged.
        expect(variantsSrc).toContain('--bg-default');
        expect(variantsSrc).toContain('text-content-emphasis');
        // The reciprocal hover edge is secondary's half of the trade:
        // it takes the BRAND edge while primary takes the complementary
        // one. That pairing is the material's whole hover language.
        expect(variantsSrc).toMatch(
            /secondary:\s*\[[\s\S]*?hover:border-\[var\(--brand-default\)\]/,
        );
    });

    it('uses semantic tokens for ghost variant', () => {
        expect(variantsSrc).toContain('bg-transparent');
        expect(variantsSrc).toContain('border-transparent');
        expect(variantsSrc).toContain('hover:bg-bg-muted');
    });

    it('supports loading state', () => {
        expect(src).toContain('loading');
        expect(src).toContain('LoadingSpinner');
    });

    it('supports disabledTooltip', () => {
        expect(src).toContain('disabledTooltip');
        expect(src).toContain('Tooltip');
    });

    it('supports children as alternative to text prop', () => {
        expect(src).toMatch(/text \?\? children/);
    });

    it('has focus-visible indicator using a token', () => {
        // R22-PR-B upgraded the focus indicator from Tailwind
        // `focus-visible:ring-ring` (default-feel) to the brand-
        // tinted box-shadow halo via `focus-visible:shadow-[var(
        // --ctrl-edge-focus)]`. Both forms are token-backed; the
        // assertion accepts either so this guardrail doesn't
        // need re-touching every time the focus geometry evolves.
        expect(variantsSrc).toMatch(
            /focus-visible:(ring-ring|shadow-\[)/,
        );
    });

    it('does not use raw light-mode colors in CVA variants', () => {
        const variantBlock = variantsSrc.slice(
            variantsSrc.indexOf('buttonVariants'),
            variantsSrc.indexOf('defaultVariants'),
        );
        const lines = variantBlock.split('\n');
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (RAW_LIGHT_COLOR_REGEX.test(lines[i])) {
                violations.push(`Line ~${i}: ${lines[i].trim()}`);
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('StatusBadge primitive', () => {
    const src = read(STATUS_BADGE);

    it('exports StatusBadge and statusBadgeVariants', () => {
        expect(src).toMatch(/export.*StatusBadge/);
        expect(src).toMatch(/export.*statusBadgeVariants/);
    });

    it('defines expected semantic variant keys', () => {
        // Roadmap-6 PR-10 retired `pending` (zero callsites; redundant
        // with `info` for in-progress / `warning` for needs-attention).
        // The `*-attention` token pair that backed it is also gone.
        for (const v of ['neutral', 'info', 'success', 'warning', 'error']) {
            expect(src).toContain(`${v}:`);
        }
    });

    it('uses semantic tokens for all status variants', () => {
        expect(src).toContain('bg-bg-info');
        expect(src).toContain('text-content-info');
        expect(src).toContain('bg-bg-success');
        expect(src).toContain('text-content-success');
        expect(src).toContain('bg-bg-warning');
        expect(src).toContain('text-content-warning');
        expect(src).toContain('bg-bg-error');
        expect(src).toContain('text-content-error');
    });

    it('neutral variant uses semantic tokens', () => {
        expect(src).toContain('bg-bg-subtle');
        expect(src).toContain('text-content-muted');
    });

    it('has size variants', () => {
        expect(src).toContain('sm:');
        expect(src).toContain('md:');
    });

    it('supports tooltip via DynamicTooltipWrapper', () => {
        expect(src).toContain('DynamicTooltipWrapper');
        expect(src).toContain('tooltip');
    });

    it('supports custom or null icon', () => {
        expect(src).toContain('icon?: Icon | null');
    });

    it('does not use raw light-mode colors in CVA variants', () => {
        const variantBlock = src.slice(
            src.indexOf('statusBadgeVariants'),
            src.indexOf('defaultIcons'),
        );
        const violations: string[] = [];
        for (const line of variantBlock.split('\n')) {
            if (RAW_LIGHT_COLOR_REGEX.test(line)) {
                violations.push(line.trim());
            }
        }
        expect(violations).toEqual([]);
    });
});

describe('EmptyState primitive', () => {
    const src = read(EMPTY_STATE);

    it('exports EmptyState and EmptyStateProps', () => {
        expect(src).toMatch(/export function EmptyState/);
        expect(src).toMatch(/export interface EmptyStateProps/);
    });

    it('accepts icon, title, description, learnMore, children, className', () => {
        // #2246 Class A — `toContain('icon:')` was satisfied by the JSDoc
        // ("Default icon: AlertCircle"), never by the prop, which is declared
        // OPTIONAL as `icon?: React.ElementType`. Name the declaration.
        expect(src).toContain('icon?: React.ElementType');
        expect(src).toContain('title:');
        expect(src).toContain('description?:');
        expect(src).toContain('learnMore?:');
        expect(src).toContain('children');
        expect(src).toContain('className?:');
    });

    it('uses semantic tokens for text and surfaces', () => {
        expect(src).toContain('text-content-emphasis');
        expect(src).toContain('text-content-muted');
        expect(src).toContain('border-border-subtle');
        expect(src).toContain('bg-bg-muted');
    });

    it('does not use raw light-mode colors', () => {
        const violations: string[] = [];
        for (const line of src.split('\n')) {
            if (RAW_LIGHT_COLOR_REGEX.test(line)) {
                violations.push(line.trim());
            }
        }
        expect(violations).toEqual([]);
    });
});
