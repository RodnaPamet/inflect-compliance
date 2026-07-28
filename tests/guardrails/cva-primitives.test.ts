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

const UI_DIR = path.resolve(__dirname, '../../src/components/ui');

function read(file: string): string {
    return fs.readFileSync(path.join(UI_DIR, file), 'utf-8');
}

const RAW_LIGHT_COLOR_REGEX =
    /(?:neutral|gray|white|slate)-(?:50|100|200|300|400|950)\b/;

describe('Button primitive', () => {
    const src = read('button.tsx');
    const variantsSrc = read('button-variants.ts');

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
        expect(variantsSrc).toMatch(/--brand-default/);
        expect(variantsSrc).toMatch(/--brand-emphasis/);
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
    const src = read('status-badge.tsx');

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
    const src = read('empty-state.tsx');

    it('exports EmptyState and EmptyStateProps', () => {
        expect(src).toMatch(/export function EmptyState/);
        expect(src).toMatch(/export interface EmptyStateProps/);
    });

    it('accepts icon, title, description, learnMore, children, className', () => {
        expect(src).toContain('icon:');
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
