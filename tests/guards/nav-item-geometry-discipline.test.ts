/**
 * Roadmap-12 PR-2 — NavItem geometry discipline.
 *
 * Five measurements drive the way a nav item feels in the hand:
 *
 *   - height  44px (`min-h-[44px]`)
 *   - padding 12×10 (`px-3 py-2.5`)
 *   - gap     8px (`gap-compact`)
 *   - radius  8px (`rounded-lg`)
 *   - icon    18×18 (`w-[18px] h-[18px]`)
 *
 * `nav-item.tsx` carries the rationale for each as a doc-comment
 * next to a named export. This ratchet locks the values so a "just
 * bump padding by 2px" PR has to argue against both the
 * doc-comment and CI.
 *
 * Why the exact values matter is in the doc-comment; the ratchet
 * just enforces that each named const exports the exact string
 * AND that `NAV_ITEM_BASE` composes them in (not parallel-hardcoded
 * elsewhere).
 *
 * Later Roadmap-12 PRs (4-9) edit hover / active / focus / icon
 * tone, NOT geometry. If a future redesign genuinely needs new
 * geometry, the contributor updates this ratchet + doc-comment in
 * the same diff — a deliberate, surfaced decision.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
// #2246 Class A — NOT converted, deliberately. This file's only text assertion
// is 'every geometry token carries a non-trivial doc-comment': its SUBJECT is
// the prose, so masking comments would blank the very thing it checks. Stays
// on the raw read and stays listed in raw-source-asserting-files.json.
const SRC = fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-item.tsx'),
    'utf8',
);

/**
 * The five tokens — name → expected string literal. A failing
 * assertion means either the value changed (intentional? update
 * here too) or the name changed (breaking change to the
 * primitive's public surface).
 */
const GEOMETRY_TOKENS: Record<string, string> = {
    // 44px touch base + 34px desktop (md:) — sidebar rows are tighter on
    // pointer devices while the mobile drawer keeps the WCAG touch target.
    NAV_ITEM_HEIGHT_MIN: 'min-h-[44px] md:min-h-[34px]',
    NAV_ITEM_PADDING: 'px-3 py-2.5 md:py-1.5',
    NAV_ITEM_GAP: 'gap-compact',
    NAV_ITEM_RADIUS: 'rounded-lg',
    // 28px (h-7) — sized up so the glyph fills the collapsed icon-rail.
    NAV_ITEM_ICON_SIZE: 'h-4 w-4',
};

describe('Roadmap-12 PR-2 — NavItem geometry discipline', () => {
    describe.each(Object.entries(GEOMETRY_TOKENS))(
        '%s',
        (name, expected) => {
            it(`exports the literal "${expected}"`, () => {
                // Match `export const NAME = '<expected>'` (single or
                // double quotes). The literal must be exact — no
                // template-literal interpolation, no class composition.
                // If a future PR moves the value into a helper, the
                // helper's output should be inlined for ratchet
                // visibility.
                const re = new RegExp(
                    `export\\s+const\\s+${name}\\s*=\\s*['"]${expected.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&',
                    )}['"]`,
                );
                expect(SRC).toMatch(re);
            });
        },
    );

    it('NAV_ITEM_BASE composes the geometry tokens (not parallel-hardcoded)', () => {
        // The base class string MUST be built from the named
        // constants. If a future refactor inlines the values back
        // into a string literal, the geometry contract becomes
        // un-discoverable.
        for (const name of Object.keys(GEOMETRY_TOKENS)) {
            // Each name appears at least once inside the BASE
            // definition. The BASE is built via an array .join — we
            // just check the name appears in the file's `BASE`
            // assignment region.
            const baseRegion = SRC.match(
                /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
            );
            expect(baseRegion).not.toBeNull();
            // Each token name must appear in BASE's array OR be
            // applied to icon JSX (icon size is consumed at the
            // `<Icon>` element, not BASE). Allow either.
            const inBase = baseRegion![0].includes(name);
            const inFile = SRC.includes(name);
            expect(inFile).toBe(true);
            if (name === 'NAV_ITEM_ICON_SIZE') {
                // Icon size is applied to the JSX element, not the
                // base class. After R12-PR9 the icon consumes
                // `NAV_ITEM_ICON_CLASS`, which itself composes
                // `NAV_ITEM_ICON_SIZE`. Accept either: direct
                // interpolation at the JSX use site, OR the
                // composition chain (JSX consumes ICON_CLASS, and
                // ICON_CLASS interpolates ICON_SIZE).
                const directAtJsx = /<Icon\b[\s\S]*?\$\{NAV_ITEM_ICON_SIZE\}/.test(SRC);
                const jsxConsumesIconClass =
                    /<Icon\b[\s\S]*?\{NAV_ITEM_ICON_CLASS\}/.test(SRC);
                const iconClassComposesSize =
                    /NAV_ITEM_ICON_CLASS\s*=\s*`[^`]*\$\{\s*NAV_ITEM_ICON_SIZE\s*\}/.test(SRC);
                const viaIndirection = jsxConsumesIconClass && iconClassComposesSize;
                expect(directAtJsx || viaIndirection).toBe(true);
            } else {
                expect(inBase).toBe(true);
            }
        }
    });

    it('every geometry token carries a non-trivial doc-comment', () => {
        // The whole point of named constants is to land the *why*
        // next to the value. A const without a doc-comment defeats
        // the discipline.
        for (const name of Object.keys(GEOMETRY_TOKENS)) {
            // Look for a JSDoc block immediately preceding the export.
            const blockBefore = new RegExp(
                `\\/\\*\\*[\\s\\S]+?\\*\\/[\\s\\n]*export\\s+const\\s+${name}\\b`,
            );
            const matched = SRC.match(blockBefore);
            expect(matched).not.toBeNull();
            // Body should be at least 60 chars after stripping the
            // JSDoc framing — caught by hand-grepping for empty
            // /** */ stubs.
            const body = matched![0]
                .replace(/\/\*\*|\*\/|\*/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            expect(body.length).toBeGreaterThan(60);
        }
    });
});
