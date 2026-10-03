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
 *   4. `animate-fade-in`    — entrance breath on first mount.
 *                              Opacity-only motion (no transform).
 *   5. a declared tempo     — the animation this repo can actually
 *                              emit for (4) carries its own
 *                              duration.
 *
 * ─── (4) and (5) used to assert a class that compiled to nothing ──
 *
 * They were `expect(recipe).toMatch(/\banimate-in\b/)` +
 * `/\bfade-in\b/` + `/\bduration-\d+\b/`, pinning
 * `animate-in fade-in duration-300`. All three were inert:
 * `animate-in` and `fade-in` are `tailwindcss-animate` classes and
 * that plugin has never been a dependency here, and plain Tailwind
 * emits `transition-duration` for `duration-300`, which an
 * animation does not read. So this ratchet was HOLDING A DEAD CLASS
 * IN PLACE — a token-presence check cannot tell a utility that
 * exists from one that does not.
 *
 * The replacement asks the question the old one could not: does
 * every `animate-*` token in the recipe RESOLVE against the two
 * places this repo declares an animation — `theme.extend.animation`
 * in `tailwind.config.js` and the hand-written `.animate-*` rules in
 * `src/app/globals.css` — plus Tailwind's own built-ins. The
 * negative control below is the historical defect itself: `in`,
 * from `animate-in`, must NOT resolve.
 *
 * What this ratchet does NOT police
 *
 *   - The badge's `variant` / `size` / `tone` — those are JSX
 *     choices made at the call site, not part of the geometric
 *     recipe. (Today: `variant="info"`, `size="sm"`, tone defaults
 *     to subtle.)
 *   - Whether the badge is rendered at all — that's the data
 *     contract (`badge != null && …`).
 *   - The keyframes of a CSS-declared `.animate-*` rule. The
 *     transform check below reads `theme.extend.keyframes`, so it
 *     reaches a config-declared animation (which `fade-in` is) and
 *     not one written straight into `globals.css`.
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

/** Tailwind's own `animate-*` keys, which need no declaration here. */
const TAILWIND_BUILT_IN_ANIMATIONS = ['spin', 'ping', 'pulse', 'bounce', 'none'];

/** `theme.extend.animation` name -> its CSS `animation` shorthand. */
const configAnimations = (): Record<string, string> =>
    require(path.join(ROOT, 'tailwind.config.js')).theme?.extend?.animation ?? {};

/** `theme.extend.keyframes` name -> its step map. */
const configKeyframes = (): Record<string, Record<string, Record<string, string>>> =>
    require(path.join(ROOT, 'tailwind.config.js')).theme?.extend?.keyframes ?? {};

/**
 * Every animation name this repo can emit an `animate-<name>` utility for.
 * Two declaration sites plus the built-ins — nothing else produces one, which
 * is exactly why `animate-in` produced none.
 */
function declaredAnimations(): Set<string> {
    const names = new Set<string>(TAILWIND_BUILT_IN_ANIMATIONS);
    for (const n of Object.keys(configAnimations())) names.add(n);
    const css = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
    for (const m of css.matchAll(/\.animate-([A-Za-z0-9_-]+)\s*\{/g)) names.add(m[1]);
    return names;
}

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

        // (4) Entrance breath, and it must be an animation this repo
        //     actually EMITS. Controls first, both directions, or the
        //     assertion below passes against a resolver that resolves
        //     everything — the shape a dead detector shares with a clean
        //     recipe.
        const declared = declaredAnimations();
        expect(declared.has('fade-in')).toBe(true); // config-declared
        expect(declared.has('fadeIn')).toBe(true); // globals.css-declared
        expect(declared.has('pulse')).toBe(true); // Tailwind built-in
        expect(declared.has('in')).toBe(false); // THE HISTORICAL DEFECT
        expect(declared.has('blink')).toBe(false); // its sibling in loading-dots

        const animateTokens = [...recipe.matchAll(/\banimate-([A-Za-z0-9_-]+)/g)].map(
            (m) => m[1],
        );
        expect(animateTokens.length).toBeGreaterThan(0);
        expect(animateTokens.filter((n) => !declared.has(n))).toEqual([]);

        // (5) Measured tempo. The duration rides the declared animation
        //     rather than a sibling `duration-*` class: Tailwind emits
        //     `transition-duration` for that class, which an animation does
        //     not read, so its presence was never evidence of a tempo.
        for (const n of animateTokens) {
            const shorthand = configAnimations()[n];
            if (shorthand === undefined) continue; // CSS-declared; see header
            expect(shorthand).toMatch(/\d+(?:\.\d+)?m?s/);
        }
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

        // The class tokens above are only half of it: with the breath now
        // riding a theme key, a transform can hide in the KEYFRAMES. The
        // tempting wrong swap is `animate-fadeIn`, this repo's other fade,
        // whose steps carry `translateY(8px)` — opacity-only is the whole
        // point of (4), so read the steps and not just the token.
        const keyframes = configKeyframes();
        for (const m of recipe.matchAll(/\banimate-([A-Za-z0-9_-]+)/g)) {
            const steps = keyframes[m[1]];
            if (steps === undefined) continue; // built-in or CSS-declared
            const props = Object.values(steps).flatMap((s) => Object.keys(s));
            // Control: the steps were actually read, so an empty `props`
            // cannot pass this vacuously.
            expect(props.length).toBeGreaterThan(0);
            expect(props).not.toContain('transform');
        }
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
