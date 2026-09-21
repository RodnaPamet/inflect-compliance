/**
 * Roadmap-12 PR-8 — NavItem badge: aligned + breathing.
 *
 * The optional count chip sits at the right of a nav row. Five
 * invariants — each carrying its own load:
 *
 *   1. `ml-auto`            — pushes badge to the right edge.
 *   2. `tabular-nums`       — fixed-width numerals (9 → 10 → 99
 *                              doesn't make the badge pop wider).
 *   3. `flex-shrink-0`      — badge holds its size; the LABEL
 *                              shrinks via `truncate` when a row
 *                              is too long.
 *   4. `animate-in fade-in` — entrance breath on first mount.
 *                              Opacity-only motion (no transform).
 *   5. `duration-300`       — measured tempo, one rung slower
 *                              than the band's 200ms so the badge
 *                              arrives just after the row settles.
 *
 * What this ratchet does NOT police
 *
 *   - The badge's `variant` / `size` / `tone` — those are JSX
 *     choices made at the call site, not part of the geometric
 *     recipe. (Today: `variant="info"`, `size="sm"`, tone defaults
 *     to subtle.)
 *   - Whether the badge is rendered at all — that's the data
 *     contract (`badge != null && …`).
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

describe('Roadmap-12 PR-8 — NavItem badge discipline', () => {
    it('exports `NAV_ITEM_BADGE` with all five invariant tokens', () => {
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_BADGE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];

        // (1) Right-aligned via margin-auto.
        expect(recipe).toMatch(/\bml-auto\b/);

        // (2) Numerals at fixed width.
        expect(recipe).toMatch(/\btabular-nums\b/);

        // (3) Badge does NOT shrink — the label is the elastic one.
        expect(recipe).toMatch(/\bflex-shrink-0\b/);

        // (4) Entrance breath — tailwindcss-animate enter primitive.
        expect(recipe).toMatch(/\banimate-in\b/);
        expect(recipe).toMatch(/\bfade-in\b/);

        // (5) Measured tempo. Any Tailwind duration token — locked
        // shape, not a specific value. (Today: `duration-300`.)
        expect(recipe).toMatch(/\bduration-\d+\b/);
    });

    it('badge recipe uses opacity-only motion (no transform / scale / translate)', () => {
        // Same motion-language discipline as the band: opacity is
        // the canonical fade-in/out mechanism for tone-only design
        // systems. `slide-in-from-*` / `zoom-in-*` / `spin-in-*`
        // would betray the language by introducing geometry into
        // chrome that should stay still.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_BADGE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];

        expect(recipe).not.toMatch(/\bslide-in-from-/);
        expect(recipe).not.toMatch(/\bzoom-in-/);
        expect(recipe).not.toMatch(/\bspin-in-/);
        expect(recipe).not.toMatch(/\b(?:hover:)?(?:scale|translate|-translate)-/);
    });

    it('badge recipe is NOT hover-gated (the entrance fires on mount, not on hover)', () => {
        // `hover:animate-in` would mean "re-fire the breath every
        // time the user hovers the row" — clownish. The entrance
        // is a once-per-mount event. Lock that.
        const match = SRC.match(
            /export\s+const\s+NAV_ITEM_BADGE\s*=\s*['"]([^'"]+)['"]/,
        );
        expect(match).not.toBeNull();
        const recipe = match![1];
        expect(recipe).not.toMatch(/\bhover:animate-/);
        expect(recipe).not.toMatch(/\bhover:fade-/);
    });

    it('the `<NavItem>` JSX consumes `NAV_ITEM_BADGE` via the StatusBadge className', () => {
        // The badge branch of the conditional render references the
        // const. A future regression that splits the badge recipe
        // into a parallel hard-coded className (e.g. an experiment
        // shortcut) would un-link the ratchet from the runtime —
        // catch it here.
        expect(SRC).toMatch(
            /<StatusBadge[^>]+className=\{NAV_ITEM_BADGE\}/,
        );
    });

    it('badge variant + size stay quiet (info + sm — never a brand tone)', () => {
        // The badge MUST NOT compete with the active state's
        // brand-subtle wash. `variant="info"` is the blue neutral
        // signal; reaching for `variant="warning"` /
        // `variant="error"` as a *default* would shout "alarm" on
        // every row. The active state owns brand tones — chrome
        // doesn't.
        //
        // Same for size — `sm` (10px text) is the row-quiet tier.
        // `md` (12px) would compete with the 14px label.
        expect(SRC).toMatch(
            /<StatusBadge\s+variant="info"\s+size="sm"/,
        );
    });
});
