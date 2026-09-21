/**
 * Roadmap-12 PR-6 — NavItem active-state discipline.
 * (R13-PR5 evolution: text-content-emphasis → text-[--brand-default].)
 *
 * The active row is the one telling you which page you're on. It
 * has to read as "settled" — not louder than the surrounding rows,
 * not quieter. Conviction expressed through four co-operating
 * tokens, no single one shouting:
 *
 *   1. `text-[var(--brand-default)]` — yellow letters on METRO,
 *      orange letters on PwC. R12-PR6 originally locked
 *      `text-content-emphasis` here (one rung brighter than muted,
 *      held permanently). R13-PR5 evolves to brand-coloured letters
 *      so the active page is visually unmissable from across the
 *      desk. Both colours clear WCAG AA on the brand-subtle wash.
 *
 *   2. `bg-[var(--brand-subtle)]` — a brand-tinted wash, ~9% (PwC
 *      orange) or ~18% (METRO yellow) over the page bg. This is
 *      what distinguishes ACTIVE from HOVER — hover shows just
 *      the band; active commits with the wash. The wash is the
 *      "you are here" claim.
 *
 *   3. `before:opacity-100` — the brand-gradient capsule band
 *      from R12-PR5, held permanently at full opacity. Same
 *      mechanism as hover, but un-gated. The band is the
 *      jewellery.
 *
 *   4. `font-medium` — one weight up from regular (400 → 500).
 *      The smallest possible step. Anything bolder (600+) reads
 *      as a heading, not a row label. The weight bump is what
 *      lets the eye PICK the active row at a glance without
 *      reading; it parses as "denser ink".
 *
 * Why none of these alone, or fewer of them?
 *   - Just the band: looks identical to hover. No "settled"
 *     state.
 *   - Just the bg: looks like the row's been selected for a
 *     batch action.
 *   - Just the text colour change: too subtle on light theme.
 *   - Just font-weight: reads as a header, not a row.
 *
 * The conviction comes from all four firing TOGETHER. This
 * ratchet locks all four.
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

describe('Roadmap-12 PR-6 — NavItem active-state discipline', () => {
    it('exports `NAV_ITEM_ACTIVE` with all four conviction tokens', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];

        // (1) Text: brand-coloured letters (R13-PR5 evolution from
        //     the R12-PR6 lock on text-content-emphasis). Yellow on
        //     METRO, orange on PwC, both via `var(--brand-default)`.
        expect(recipe).toMatch(/\btext-\[var\(--brand-default\)\]/);

        // (2) Background: brand wash. R12-PR6 originally locked the
        //     uniform `bg-[var(--brand-subtle)]` (warm tint).
        //     R13-PR11 evolved it to a radial gradient from
        //     `--brand-secondary-subtle` (cool tint, coherent with
        //     the navy band) fading right. Either form is accepted —
        //     a regression that drops BOTH would render no wash at
        //     all, which we still catch.
        const r12Wash = /\bbg-\[var\(--brand-subtle\)\]/.test(recipe);
        const r13Wash =
            /bg-\[radial-gradient\(/.test(recipe) &&
            /var\(--brand(-secondary)?-subtle\)/.test(recipe);
        expect(r12Wash || r13Wash).toBe(true);

        // (3) Band: held visible (opacity 100, not hover-gated).
        expect(recipe).toMatch(/(?<!hover:)\bbefore:opacity-100\b/);

        // (4) Weight: one rung up from regular (the new addition
        // R12-PR6 locks). 400 → 500. Anything bolder reads as a
        // heading.
        expect(recipe).toMatch(/\bfont-medium\b/);
    });

    it('active state does NOT bump the weight past medium', () => {
        // `font-semibold` (600) or `font-bold` (700) would make the
        // active row read as a heading, not a row label. The
        // discipline is +1 step from regular — no more.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];
        expect(recipe).not.toMatch(/\bfont-(semibold|bold|black|extrabold)\b/);
    });

    it('active state does NOT use a transform / scale / translate', () => {
        // Same evergreen contract as the default state — the
        // active row must not animate-in via geometry. Motion
        // language is band-opacity + text-colour. Geometry stays
        // still.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];
        expect(recipe).not.toMatch(
            /\b(?:hover|group-hover)?:?(?:scale|translate|-translate)\b/,
        );
    });

    it('active state does NOT carry the retired R12-pre-PR-5 left-border slot', () => {
        // Pre-R12-PR5, the active recipe was
        //   `... border-l-[var(--brand-default)] ...`
        // and `NAV_ITEM_BASE` carried the `border-l-2 border-l-
        // transparent` slot. R12-PR5 retired the mechanism in
        // favour of the gradient band. Catch a regression that
        // brings back the old border-left + the new band, which
        // would render TWO left edges.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];
        expect(recipe).not.toMatch(/border-l-\[var\(--brand-default\)\]/);
        expect(recipe).not.toMatch(/border-l-2\b/);
    });

    it('active state does NOT reach for a hard brand fill', () => {
        // `bg-brand-default` / `bg-brand-emphasis` would paint a
        // solid orange/yellow block — the user can pick the active
        // row from across the room, which is the opposite of
        // "settled in". The discipline is brand-subtle (a wash),
        // never the saturated brand tone.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_ACTIVE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];
        expect(recipe).not.toMatch(
            /\bbg-\[var\(--brand-(default|emphasis)\)\]/,
        );
    });

    it('the `<NavItem>` JSX consumes `NAV_ITEM_ACTIVE` via the active ternary', () => {
        // The active branch of the ternary references the const.
        // If a future regression splits the active recipe into
        // multiple paths (e.g. an experiment shortcut that bypasses
        // the const), the ratchet wouldn't see it. Lock the
        // ternary shape.
        expect(SRC).toMatch(
            /active\s*\?\s*NAV_ITEM_ACTIVE\s*:\s*NAV_ITEM_DEFAULT/,
        );
    });
});
