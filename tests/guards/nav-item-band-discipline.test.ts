/**
 * Roadmap-12 PR-5 — NavItem brand-gradient band discipline.
 *
 * Hover/active rows are signalled by a 3-px wide, capsule-shaped
 * brand-gradient band pinned to the LEFT of the row — not by a
 * full-row hover tint. The band is a `::before` pseudo-element on
 * the `<Link>`, fading from opacity 0 (default) to opacity 100
 * (hover or active).
 *
 * Five invariants matter:
 *
 *   1. The `::before` pseudo is positioned absolute, pinned to
 *      `left-0`, inset `top-1.5 bottom-1.5` from the edges
 *      (giving it the capsule shape — jewellery, not ruler).
 *
 *   2. Width is exactly `3px` — narrow enough to feel like
 *      decoration, wide enough for the gradient to read.
 *
 *   3. Right edge is `rounded-r-full` — the capsule's tail.
 *      Without it the band would feel like a square stamp.
 *
 *   4. The gradient runs vertical (`to-b`) from `--brand-default`
 *      (top) to `--brand-emphasis` (bottom). Two stops, same hue
 *      family — fluid deepening, not a rainbow.
 *
 *   5. The transition is opacity-only at 200ms ease-out. The
 *      motion-language ratchet bans transform / scale / translate
 *      product-wide; this ratchet locks opacity + duration at the
 *      primitive level too.
 *
 * What this ratchet does NOT police
 *
 *   - The exact pixel width or inset values. R12 future PRs can
 *     tune (3→4px, 1.5→2 inset) — but the SHAPE of the recipe is
 *     locked.
 *   - Where the band is consumed (hover vs active). Those live in
 *     `NAV_ITEM_DEFAULT` / `NAV_ITEM_ACTIVE` and are covered by
 *     the default-state + (eventually) active-state ratchets.
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

describe('Roadmap-12 PR-5 — NavItem brand-gradient band discipline', () => {
    it('positions the `::before` band capsule on the left edge', () => {
        // Absolute positioning + left-0 + inset top/bottom.
        expect(SRC).toMatch(/before:absolute/);
        expect(SRC).toMatch(/before:left-0/);
        // `top-1.5 bottom-1.5` = 6px inset top/bottom. Future PRs
        // can tune the inset; for now the recipe is locked.
        expect(SRC).toMatch(/before:top-1\.5/);
        expect(SRC).toMatch(/before:bottom-1\.5/);
    });

    it('uses exactly 3px width', () => {
        // Narrow enough to feel like decoration, wide enough for
        // the gradient to read. Pre-R12-PR5 the recipe was 2px
        // (a hard `border-l-2`). 3 is the sweet spot for a
        // gradient that needs to "glow".
        expect(SRC).toMatch(/before:w-\[3px\]/);
    });

    it('has a rounded right edge (capsule tail)', () => {
        // `rounded-r-full` gives the band its capsule shape.
        // Without it the band feels like a square stamp.
        expect(SRC).toMatch(/before:rounded-r-full/);
    });

    it('paints a vertical brand-gradient (default → emphasis)', () => {
        // R12-PR5 originally locked this as Tailwind utility classes
        // (`before:bg-gradient-to-b`, `before:from-...`,
        // `before:to-...`). R13-PR2 added the via-muted midstop in
        // the same form. R15-PR1 (stardust trail) had to switch the
        // form because Tailwind utility classes only emit ONE
        // background-image, and the stardust effect stacks radial
        // particles on TOP of the linear gradient — requiring a
        // single comprehensive `before:bg-[...]` arbitrary value.
        //
        // Both forms are accepted here; the load-bearing piece is
        // that the brand stops (`--brand-default`, `--brand-emphasis`)
        // BOTH appear inside whichever bg-image form the recipe
        // uses, in the canonical top-to-bottom order. The
        // `linear-gradient(to bottom, ...)` arbitrary form
        // preserves the visual contract verbatim.
        const utilityForm =
            /before:bg-gradient-to-b/.test(SRC) &&
            /before:from-\[var\(--brand-default\)\]/.test(SRC) &&
            /before:to-\[var\(--brand-emphasis\)\]/.test(SRC);
        const arbitraryForm =
            /before:bg-\[[\s\S]*?linear-gradient\(to_bottom/.test(SRC) &&
            /before:bg-\[[\s\S]*?var\(--brand-default\)/.test(SRC) &&
            /before:bg-\[[\s\S]*?var\(--brand-emphasis\)/.test(SRC);
        expect(utilityForm || arbitraryForm).toBe(true);
    });

    it('defaults to opacity 0 and transitions opacity (+ R13-PR9 geometry props)', () => {
        // The band is invisible until hover/active triggers it.
        // Transition was opacity-only (R12-PR5); R13-PR9 broadened
        // the property list to also animate top/bottom/width when
        // the band reaches toward the cursor on hover. Both forms
        // are accepted here — `before:transition-opacity` (R12) or
        // `before:transition-[opacity,top,bottom,width]` (R13+).
        // 200ms ease-out is preserved verbatim.
        expect(SRC).toMatch(/before:opacity-0\b/);
        expect(SRC).toMatch(
            /before:transition-(opacity\b|\[opacity[^\]]*\])/,
        );
        expect(SRC).toMatch(/before:duration-200/);
        expect(SRC).toMatch(/before:ease-out/);
    });

    it('NAV_ITEM_BASE includes `relative` to anchor the `::before` pseudo', () => {
        // Without `position: relative` on the parent, the
        // `::before absolute` would escape to the next positioned
        // ancestor. The band has to anchor to the row.
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        expect(baseRegion![0]).toMatch(/['"]relative\s+flex/);
    });

    it('hover state does NOT reveal the band (2026-05-19 — band is active-only)', () => {
        // The R12-PR5 hover reveal (`hover:before:opacity-100`) was
        // retired 2026-05-19 at the user's request. The brand-gradient
        // band still ships and still anchors the active row — but the
        // hover state now expresses itself through text-brighten +
        // gloss + bevel-shadow + liquid-sweep ONLY. No band fade-in.
        const defaultRecipe = SRC.match(
            /export\s+const\s+NAV_ITEM_DEFAULT\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(defaultRecipe).not.toBeNull();
        expect(defaultRecipe![1]).not.toMatch(/hover:before:opacity-100/);
    });

    it('active state holds the band visible (opacity 100)', () => {
        // The active state recipe sets `before:opacity-100`
        // unconditionally. This is the "always lit" state for the
        // current page.
        const activeRecipe = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(activeRecipe).not.toBeNull();
        // Match `before:opacity-100` but NOT `hover:before:opacity-100`
        // (that's the default-state mechanism).
        expect(activeRecipe![1]).toMatch(/(?<!hover:)\bbefore:opacity-100\b/);
    });

    it('the retired pre-R12-PR5 left-border slot is gone', () => {
        // The old mechanism was `border-l-2 border-l-transparent`
        // on BASE + `border-l-[var(--brand-default)]` on ACTIVE.
        // R12-PR5 replaced this with the band. The old tokens
        // must not co-exist (would double-render the left edge).
        const baseRegion = SRC.match(
            /export\s+const\s+NAV_ITEM_BASE\s*=\s*\[[\s\S]+?\]\.join\(/,
        );
        expect(baseRegion).not.toBeNull();
        expect(baseRegion![0]).not.toMatch(/border-l-2/);
        // ACTIVE no longer references the brand-default border.
        const activeRecipe = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(activeRecipe).not.toBeNull();
        expect(activeRecipe![1]).not.toMatch(
            /border-l-\[var\(--brand-default\)\]/,
        );
    });
});
