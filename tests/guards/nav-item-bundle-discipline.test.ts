/**
 * Roadmap-12 PR-10 — NavItem BUNDLE ratchet (capstone).
 *
 * The per-PR ratchets (geometry, default, band, active, focus, badge,
 * icon, import, section) each police one slice of the recipe. This
 * ratchet is the forward contract: one file that walks the full
 * NavItem primitive and asserts every exported const + composition
 * line is present, so a refactor that drops a token at the const
 * level fails the build BEFORE the slice-level ratchets see it.
 *
 * Why a single capstone ratchet?
 *   - Reading test failures one at a time tells you what broke; the
 *     capstone tells you "the NavItem contract as a whole is broken,
 *     here are all the missing pieces in one report".
 *   - It's the only file in the R12 suite that walks ALL the
 *     invariants without re-deriving them — a forward-stable summary.
 *   - Future-proofs against "refactored everything into a cva()" PRs
 *     that touch every per-PR ratchet at once: the bundle ratchet is
 *     the high-level shape contract that survives an internal
 *     restructure as long as the named exports + composition land
 *     correctly.
 *
 * Why a regex scan (not a runtime import)?
 *   - The node jest project doesn't mock `@dub/utils`, which
 *     transitively reaches NavItem via StatusBadge. Runtime import
 *     would need a parallel mock infrastructure. A file scan is
 *     equivalent for the shape contract this ratchet enforces.
 *   - The jsdom-based rendered test at
 *     `tests/rendered/nav-item-states.test.tsx` IS the runtime
 *     consumer — it asserts the const values flow into rendered
 *     class strings end-to-end.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
));

const EXPECTED_NAMED_EXPORTS = [
    'NAV_ITEM_HEIGHT_MIN',
    'NAV_ITEM_PADDING',
    'NAV_ITEM_GAP',
    'NAV_ITEM_RADIUS',
    'NAV_ITEM_ICON_SIZE',
    'NAV_ITEM_ICON_CLASS',
    'NAV_ITEM_BASE',
    'NAV_ITEM_DEFAULT',
    'NAV_ITEM_ACTIVE',
    'NAV_ITEM_BADGE',
];

describe('Roadmap-12 PR-10 — NavItem bundle discipline (capstone)', () => {
    describe('all ten named consts are exported', () => {
        it.each(EXPECTED_NAMED_EXPORTS)(
            'exports `%s`',
            (name) => {
                const pattern = new RegExp(`export\\s+const\\s+${name}\\b`);
                expect(SRC).toMatch(pattern);
            },
        );
    });

    it('exports the `NavItem` component (function)', () => {
        expect(SRC).toMatch(/export\s+function\s+NavItem\s*\(/);
    });

    describe('BASE composition is intact', () => {
        // The BASE is a multi-line `[ ... ].join(' ')`. The capstone
        // asserts each load-bearing piece appears inside the joined
        // array region.
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );

        it('composes via [ ... ].join (the canonical multi-line shape)', () => {
            expect(baseRegion).not.toBeNull();
        });

        const region = baseRegion![0];

        it.each([
            ['NAV_ITEM_HEIGHT_MIN'],
            ['NAV_ITEM_PADDING'],
            ['NAV_ITEM_GAP'],
            ['NAV_ITEM_RADIUS'],
            ['NAV_ITEM_BAND_BASE'],
        ])('BASE composition references %s', (name) => {
            expect(region).toContain(name);
        });

        it('BASE carries the structural row layout (relative, flex, items-center)', () => {
            expect(region).toMatch(/\brelative\b/);
            expect(region).toMatch(/\bflex items-center\b/);
        });

        it('BASE carries the colour transition (NOT transition-all)', () => {
            expect(region).toMatch(/\btransition-colors\b/);
            expect(region).not.toMatch(/\btransition-all\b/);
        });

        it('BASE carries the full focus-visible recipe', () => {
            expect(region).toContain('focus-visible:outline-none');
            expect(region).toContain('focus-visible:ring-2');
            expect(region).toContain('focus-visible:ring-[var(--ring)]');
            expect(region).toContain('focus-visible:ring-offset-2');
            expect(region).toContain('focus-visible:ring-offset-bg-default');
        });
    });

    describe('DEFAULT recipe is intact', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_DEFAULT\s*=\s*['"]([^'"]+)['"]/,
        );

        it('exports a string literal (single source of truth)', () => {
            expect(match).not.toBeNull();
        });

        const recipe = match![1];

        it('contains text-content-muted + hover:text-content-emphasis', () => {
            expect(recipe).toContain('text-content-muted');
            expect(recipe).toContain('hover:text-content-emphasis');
        });

        it('does NOT contain the hover band reveal (retired 2026-05-19)', () => {
            // The band stayed on the active row; hover speaks
            // through text-brighten + gloss + bevel + liquid-sweep
            // only. The `::before` element still exists in BASE
            // (used by ACTIVE) — just no hover trigger.
            expect(recipe).not.toContain('hover:before:opacity-100');
        });
    });

    describe('ACTIVE recipe — conviction tokens intact (R13 evolved)', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );

        it('exports a string literal', () => {
            expect(match).not.toBeNull();
        });

        const recipe = match![1];

        // Tokens that survived the R13 evolution unchanged.
        it.each([['before:opacity-100'], ['font-medium']])(
            'ACTIVE contains %s',
            (token) => {
                expect(recipe).toContain(token);
            },
        );

        it('ACTIVE carries an emphasised text colour', () => {
            // R12-PR6: `text-content-emphasis`.
            // R13-PR5:  `text-[var(--brand-default)]` (brand-coloured
            //           letters — yellow on METRO, orange on PwC).
            const r12 = /\btext-content-emphasis\b/.test(recipe);
            const r13 = /\btext-\[var\(--brand-default\)\]/.test(recipe);
            expect(r12 || r13).toBe(true);
        });

        it('ACTIVE carries a brand wash', () => {
            // R12-PR6: uniform `bg-[var(--brand-subtle)]`.
            // R13-PR11: radial gradient from
            //           `--brand-secondary-subtle` fading right.
            const r12 = /\bbg-\[var\(--brand-subtle\)\]/.test(recipe);
            const r13 =
                /bg-\[radial-gradient\(/.test(recipe) &&
                /var\(--brand(-secondary)?-subtle\)/.test(recipe);
            expect(r12 || r13).toBe(true);
        });
    });

    describe('BADGE recipe — five tokens intact', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_BADGE\s*=\s*['"]([^'"]+)['"]/,
        );

        it('exports a string literal', () => {
            expect(match).not.toBeNull();
        });

        const recipe = match![1];

        it('contains ml-auto + tabular-nums + flex-shrink-0', () => {
            expect(recipe).toContain('ml-auto');
            expect(recipe).toContain('tabular-nums');
            expect(recipe).toContain('flex-shrink-0');
        });

        it('contains the entrance breath (animate-in + fade-in + duration-N)', () => {
            expect(recipe).toContain('animate-in');
            expect(recipe).toContain('fade-in');
            expect(recipe).toMatch(/\bduration-\d+\b/);
        });
    });

    describe('ICON_CLASS composes ICON_SIZE + flex-shrink-0', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ICON_CLASS\s*=\s*`([^`]+)`/,
        );

        it('is a template literal (template-string composition)', () => {
            expect(match).not.toBeNull();
        });

        const recipe = match![1];

        it('interpolates NAV_ITEM_ICON_SIZE', () => {
            expect(recipe).toMatch(/\$\{\s*NAV_ITEM_ICON_SIZE\s*\}/);
        });

        it('contains flex-shrink-0', () => {
            expect(recipe).toContain('flex-shrink-0');
        });
    });

    describe('NavItem JSX consumes the consts (no parallel hand-roll)', () => {
        it('Link className composes BASE + DEFAULT/ACTIVE', () => {
            // Composed via cn(...) so the collapsed icon-rail can append
            // `justify-center` (centred icon when the labels are hidden).
            // The first two args remain BASE + the active ternary.
            expect(SRC).toMatch(
                /className=\{cn\(\s*NAV_ITEM_BASE,\s*active\s*\?\s*NAV_ITEM_ACTIVE\s*:\s*NAV_ITEM_DEFAULT/,
            );
        });

        it('Icon className consumes NAV_ITEM_ICON_CLASS + aria-hidden="true"', () => {
            expect(SRC).toMatch(
                /<Icon\s+className=\{NAV_ITEM_ICON_CLASS\}\s+aria-hidden="true"\s*\/>/,
            );
        });

        it('StatusBadge className consumes NAV_ITEM_BADGE', () => {
            expect(SRC).toMatch(/<StatusBadge[^>]+className=\{NAV_ITEM_BADGE\}/);
        });
    });

    describe('canonical geometry values (the four pixel decisions)', () => {
        // Lock the actual values here so a future PR that drifts the
        // 18×18 / 44px / 12-10px padding / 8px gap / 8px radius can't
        // slip through the structural ratchet.
        it.each([
            // 44px touch base + 34px desktop (md:) — see nav-item.tsx.
            ['NAV_ITEM_HEIGHT_MIN', 'min-h-[44px] md:min-h-[34px]'],
            ['NAV_ITEM_PADDING', 'px-3 py-2.5 md:py-1.5'],
            ['NAV_ITEM_GAP', 'gap-compact'],
            ['NAV_ITEM_RADIUS', 'rounded-lg'],
            ['NAV_ITEM_ICON_SIZE', 'h-4 w-4'],
        ])('%s = "%s"', (name, value) => {
            const pattern = new RegExp(
                `export\\s+const\\s+${name}\\s*=\\s*['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
            );
            expect(SRC).toMatch(pattern);
        });
    });
});
