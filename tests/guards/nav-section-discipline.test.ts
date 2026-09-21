/**
 * Roadmap-12 PR-3 — `<NavSection>` discipline.
 *
 * The sidebar's section header is the chiselled-in label —
 * unmarkable, quiet, definite. Three invariants matter:
 *
 *   1. The header renders as a `<span>` (no default `cursor: text`)
 *      AND carries `select-none` (double-click can't highlight
 *      "Govern" / "Comply" / "Manage").
 *
 *   2. The recipe is tightened from the page-level Eyebrow:
 *        - `text-[10px]` (one click smaller; the section title is
 *           a whisper, not a headline)
 *        - `tracking-[0.12em]` (deliberate, not stretched)
 *        - `text-content-subtle` (one rung quieter than the
 *           page-level Eyebrow's `text-content-muted`)
 *
 *   3. A 1-px hairline above each section title at
 *      `border-border-subtle/40`, suppressed on the first section
 *      so the very top of the sidebar doesn't pick up an
 *      accidental rule (handled via the `isFirst` prop).
 *
 * The values themselves can be tuned by future PRs (10px → 11px,
 * 0.12em → 0.14em, etc.) — but the SHAPE of the recipe is locked.
 * A future PR that drops `select-none` or reaches for a `<p>` has
 * to argue against the ratchet.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SECTION_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-section.tsx'),
    'utf8',
));
const SIDEBAR_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/SidebarNav.tsx'),
    'utf8',
));

describe('Roadmap-12 PR-3 — NavSection discipline', () => {
    describe('`nav-section.tsx` shape', () => {
        it('is a client module', () => {
            expect(SECTION_SRC.trimStart()).toMatch(/^['"]use client['"]/);
        });

        it('exports `NavSection` + the two recipe consts', () => {
            expect(SECTION_SRC).toMatch(/export\s+function\s+NavSection\b/);
            expect(SECTION_SRC).toMatch(/export\s+const\s+NAV_SECTION_HEADER\b/);
            expect(SECTION_SRC).toMatch(/export\s+const\s+NAV_SECTION_DIVIDER\b/);
        });

        it('renders the section title as a `<span>` (no default text cursor)', () => {
            // A `<p>` would inherit `cursor: text` from user-agent
            // styles; a `<h2>` would land in the page outline. A
            // `<span>` is the right shape for a decorative
            // section label.
            expect(SECTION_SRC).toMatch(
                /<span\s+className=\{NAV_SECTION_HEADER\}\s*>\s*\n?\s*\{title\}/,
            );
            // Sanity: no `<p>`, `<h2>`, etc. for the title.
            // Match the conditional-render block `{title && (` (the icon-rail
            // adds `&& !collapsed` to drop the header text) through its `)}`.
            const titleRegion = SECTION_SRC.match(
                /\{title\s*&&\s*(?:!collapsed\s*&&\s*)?\([\s\S]+?\)\}/,
            );
            expect(titleRegion).not.toBeNull();
            expect(titleRegion![0]).not.toMatch(/<(p|h[1-6])\b/);
        });

        it('header recipe includes `select-none`', () => {
            // The user-visible promise — double-click cannot select
            // the section label. If a future "let me just bump the
            // styling" PR drops select-none, it fails this check.
            expect(SECTION_SRC).toMatch(
                /export\s+const\s+NAV_SECTION_HEADER\s*=\s*['"][^'"]*\bselect-none\b/,
            );
        });

        it('header recipe carries the tightened typography tokens', () => {
            // The recipe is one string; assert each tightened token
            // appears in it. Future PRs can tune values; the
            // *shape* is locked.
            const headerLine = SECTION_SRC.match(
                /export\s+const\s+NAV_SECTION_HEADER\s*=\s*['"]([^'"]+)['"]/,
            );
            expect(headerLine).not.toBeNull();
            const recipe = headerLine![1];
            expect(recipe).toMatch(/text-\[10px\]/);
            expect(recipe).toMatch(/tracking-\[0\.12em\]/);
            expect(recipe).toMatch(/font-semibold/);
            expect(recipe).toMatch(/uppercase/);
            expect(recipe).toMatch(/text-content-subtle/);
        });

        it('divider recipe is a 1-px hairline (R13-PR10: soft gradient)', () => {
            // R12-PR3 originally locked `border-t border-border-
            // subtle/40` here. R13-PR10 evolves the divider to a
            // `::before` pseudo-element painted with a horizontal
            // gradient (transparent → --border-subtle → transparent).
            // The line is still 1px tall and quiet, but now fades in
            // and out across the row width — reads as breath rather
            // than architecture.
            //
            // Both forms are accepted here:
            //   • R12: `border-t border-border-subtle/40`
            //   • R13: `before:bg-[linear-gradient(...,--border-subtle,...)]`
            //
            // A future PR that drops BOTH leaves no divider — caught.
            const dividerLine = SECTION_SRC.match(
                /export\s+const\s+NAV_SECTION_DIVIDER\s*=\s*['"]([^'"]+)['"]/,
            );
            expect(dividerLine).not.toBeNull();
            const recipe = dividerLine![1];
            const r12Form =
                /border-t/.test(recipe) &&
                /border-border-subtle\/40/.test(recipe);
            const r13Form =
                /before:absolute/.test(recipe) &&
                /before:h-px/.test(recipe) &&
                /before:bg-\[linear-gradient\(/.test(recipe) &&
                /var\(--border-subtle\)/.test(recipe);
            expect(r12Form || r13Form).toBe(true);
        });

        it('`isFirst` suppresses the divider', () => {
            // The divider class only applies when isFirst is false.
            // Catches a "let me drop the conditional" regression
            // that would put a hairline at the very top of the
            // sidebar.
            expect(SECTION_SRC).toMatch(
                /!isFirst\s*&&\s*title\s*&&\s*NAV_SECTION_DIVIDER/,
            );
        });
    });

    describe('`SidebarNav.tsx` uses the primitive', () => {
        it('imports `NavSection` from `./nav-section`', () => {
            expect(SIDEBAR_SRC).toMatch(
                /import\s*\{\s*NavSection\s*\}\s*from\s*['"]\.\/nav-section['"]/,
            );
        });

        it('does not redeclare `NavSection` inline', () => {
            // The legacy inline definition lived here. Catch a
            // future regression where someone re-introduces a
            // local NavSection.
            expect(SIDEBAR_SRC).not.toMatch(/function\s+NavSection\b/);
        });

        it('threads `isFirst` into the section render', () => {
            // The render site MUST forward isFirst so the top
            // hairline gets suppressed on the first titled section.
            expect(SIDEBAR_SRC).toMatch(/isFirst=\{[^}]+\}/);
        });
    });
});
