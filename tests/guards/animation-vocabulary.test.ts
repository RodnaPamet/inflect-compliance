/**
 * Roadmap-6 PR-1 — animation vocabulary discipline.
 *
 * The product had drifted to FIVE animation tokens for variations
 * of "appearing":
 *
 *   animate-fadeIn         (CSS, 0.3s, opacity + translateY 8→0)  103×
 *   animate-fade-in        (Tailwind, 0.15s, pure opacity)          4×
 *   animate-slide-up-fade  (Tailwind, 0.2s, translateY 6→0+opacity) 3×
 *   animate-slideIn        (CSS, 0.3s, opacity + translateX -10→0)  2×
 *   animate-scale-in       (Tailwind, 0.15s, scale 0.95→1+opacity)  1×
 *
 * Five tokens for visually-similar effects produced two real
 * problems:
 *
 *   1. The eye registered the difference between sliding-from-left
 *      (`slideIn`) and rising-from-below (`fadeIn`) on master-detail
 *      panes — only two callsites used `slideIn`, so the product
 *      surface read as "almost coordinated, but moving."
 *
 *   2. `fadeIn` and `fade-in` are not aliases. They run at 0.3s vs
 *      0.15s with different transforms. Two near-identical names
 *      with different effects is a maintenance trap.
 *
 * What lands
 *
 *   `animate-slideIn` is retired. Two callsites (master-detail
 *   panes in `audits/AuditsClient` and `clauses/ClausesBrowser`)
 *   migrate to `animate-fadeIn`. The CSS `@keyframes slideIn` +
 *   `.animate-slideIn` rules are removed from `globals.css`.
 *
 * The surviving canonical set
 *
 *   - `animate-fadeIn`        — page-level + content enter (0.3s)
 *   - `animate-fade-in`       — overlay backdrop (opacity-only, 0.15s)
 *   - `animate-slide-up-fade` — popover / tooltip enter (0.2s)
 *   - `animate-scale-in`      — modal panel enter (0.15s)
 *   - `animate-pulse`         — skeletons (loading)
 *   - `animate-spin`          — spinners
 *
 *   `fadeIn` and `fade-in` survive as DISTINCT animations because
 *   they do different things — opacity-only (backdrop) vs
 *   opacity+translateY (content). The names are kept disambiguated
 *   by the dash convention (`fade-in` is Tailwind/lowercase-dashed,
 *   `fadeIn` is CSS/camelCase). Future contributors choose by
 *   intent: backdrop = `fade-in`; content = `fadeIn`.
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may use `animate-slideIn`. The
 *   visual was redundant with `animate-fadeIn`; one of them had
 *   to go.
 *
 * What this ratchet does NOT police
 *
 *   - WHICH named animation a callsite picks (the vocabulary above is
 *     guidance, not enforced). Only that the one it picks EXISTS.
 *   - Custom `transition-*` declarations on individual elements.
 *   - `motion/` library imports — those compose motion via JS
 *     instead of named CSS animations.
 *
 * ── THE ENUMERATOR (added 2026-10-03) ─────────────────────────────
 *
 * Everything above this line hunts ONE retired name. That is a
 * useful check and a misleading one to find in a file called
 * "animation vocabulary": it would stay green if every `animate-*`
 * token in the product were invented, because it never asks what the
 * tokens it is NOT looking for resolve to.
 *
 * They did not all resolve. Four `animate-*` families named no
 * animation at all, and three had already been found and repaired one
 * file at a time, each with a careful docblock about its own file:
 *
 *   `animate-spinner`                — loading-spinner.tsx, fixed earlier
 *                                      ("IT DID NOT SPIN (fixed here)")
 *   `animate-blink`                  — loading-dots.tsx, fixed in #3133
 *                                      ("THEY DID NOT BLINK (fixed here)")
 *   `animate-in fade-in`             — nav-item.tsx, fixed in #3133.
 *                                      `tailwindcss-animate`, which supplies
 *                                      `animate-in`, is NOT a dependency of
 *                                      this repo; the JSDoc described it as
 *                                      "Tailwindcss-animate's enter animation
 *                                      primitive" for an absent plugin.
 *   `animate-accordion-up` / `-down` — accordion.tsx, fixed HERE.
 *
 * Nobody built the thing that enumerates, so the fourth instance was
 * found the same way as the first three: by somebody happening to look.
 * The symptom is quiet by construction — Tailwind emits no utility for
 * an animation nobody declared, so the class is simply inert and the
 * element renders in its resting state, which reads as a deliberate
 * design choice rather than a defect.
 *
 * So: resolve EVERY `animate-*` token against every place an animation
 * can actually come from, and fail on any that comes from none.
 *
 *   1. `tailwind.config.js` → `theme.extend.animation` keys. Loaded via
 *      the `@config` directive on line 8 of globals.css, which is what
 *      makes a v3-style config live under Tailwind v4.
 *   2. `globals.css` → `.animate-X { }` rules, and any `--animate-X`
 *      custom property in an `@theme` block.
 *   3. Tailwind v4's own built-ins, read from the INSTALLED
 *      theme (via `require.resolve('tailwindcss/theme.css')`) rather than
 *      hard-coded or spelled as a path, so
 *      an upgrade that adds or removes one cannot leave this guard
 *      asserting against a list the framework no longer has.
 *      Plus `animate-none`, which v4 emits as a static utility
 *      (`animation: none`) with no theme key behind it.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

interface Offence {
    file: string;
    line: number;
    snippet: string;
}

describe('Animation vocabulary discipline (Roadmap-6 PR-1)', () => {
    it('animate-slideIn is retired (zero callsites)', () => {
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.(tsx?|css)$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const raw = fs.readFileSync(full, 'utf-8');
                // Strip line comments + block comments first so the
                // documentation note in globals.css explaining the
                // retirement doesn't trip the scanner.
                const stripped = raw
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/\/\/[^\n]*/g, '');
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    if (/\banimate-slideIn\b/.test(line)) {
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `\`animate-slideIn\` is retired (Roadmap-6 PR-1). The translateX reveal was redundant with \`animate-fadeIn\`'s 8px translateY enter. Use \`animate-fadeIn\` for content reveal:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });

    // ── Resolution sources ───────────────────────────────────────
    //
    // Each returns the set of animation NAMES (the part after
    // `animate-`) that source can satisfy. Read live; nothing here is
    // a transcribed list that can go stale against the thing it
    // mirrors.

    const stripComments = (src: string) =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    /** `theme.extend.animation` keys from the repo's own Tailwind config. */
    const configAnimationNames = (): Set<string> => {
        const cfg = require(path.join(ROOT, 'tailwind.config.js'));
        return new Set(
            Object.keys(cfg?.theme?.extend?.animation ?? {}),
        );
    };

    /** `.animate-X { }` rules and `--animate-X:` properties in globals.css. */
    const cssAnimationNames = (): Set<string> => {
        const css = stripComments(
            fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf-8'),
        );
        const names = new Set<string>();
        for (const m of css.matchAll(/\.animate-([A-Za-z0-9-]+)\s*\{/g))
            names.add(m[1]);
        for (const m of css.matchAll(/--animate-([A-Za-z0-9-]+)\s*:/g))
            names.add(m[1]);
        return names;
    };

    /**
     * Tailwind v4's built-ins, read from the INSTALLED theme so an
     * upgrade cannot silently invalidate this guard. `none` is added
     * because `animate-none` is a static utility with no theme key.
     */
    const builtinAnimationNames = (): Set<string> => {
        // Resolved, not spelled. `dependency-paths-are-resolved` rejects a
        // built filesystem path into an installed package, and it is right
        // to: `node_modules/tailwindcss/theme.css` is only correct under one
        // hoisting layout, and would read as ABSENT (not as an error) under
        // another — making every token resolve against an empty built-in set.
        const themeCss = fs.readFileSync(
            require.resolve('tailwindcss/theme.css'),
            'utf-8',
        );
        const names = new Set<string>(['none']);
        for (const m of themeCss.matchAll(/--animate-([A-Za-z0-9-]+)\s*:/g))
            names.add(m[1]);
        return names;
    };

    /**
     * Every `animate-*` token used anywhere under `src/`, with its
     * callsites. Comments are stripped first — `loading-spinner.tsx`'s
     * docblock quotes the broken `animate-spinner` class it replaced,
     * and `globals.css` quotes the retired `animate-slideIn`; both are
     * prose about a class no element carries.
     *
     * `animate-[...]` arbitrary values are skipped: they carry their
     * own definition and resolve against nothing.
     */
    const animateTokenUses = (): Map<string, Offence[]> => {
        const uses = new Map<string, Offence[]>();
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.(tsx?|css)$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                stripComments(fs.readFileSync(full, 'utf-8'))
                    .split('\n')
                    .forEach((line, i) => {
                        for (const m of line.matchAll(
                            /\banimate-(?!\[)([A-Za-z0-9][A-Za-z0-9-]*)/g,
                        )) {
                            const list = uses.get(m[1]) ?? [];
                            list.push({
                                file: rel,
                                line: i + 1,
                                snippet: line.trim().slice(0, 160),
                            });
                            uses.set(m[1], list);
                        }
                    });
            }
        };
        walk(path.join(ROOT, 'src'));
        return uses;
    };

    it('the resolver can express both answers, and no source reads empty', () => {
        const config = configAnimationNames();
        const css = cssAnimationNames();
        const builtin = builtinAnimationNames();
        const declared = new Set([...config, ...css, ...builtin]);

        // A source that silently read nothing would make every token
        // unresolved — loud, and therefore safe. A source that read
        // EVERYTHING would make every token resolve — silent, and
        // therefore not. These bound the second case.
        expect(config.size).toBeGreaterThanOrEqual(20);
        expect(config.has('slide-up-fade')).toBe(true);
        expect(css.has('fadeIn')).toBe(true);
        expect(builtin.has('spin')).toBe(true);
        expect(builtin.has('pulse')).toBe(true);
        expect(builtin.has('none')).toBe(true);
        // Not a kitchen sink: v4 ships a handful, not hundreds.
        expect(builtin.size).toBeLessThanOrEqual(12);

        // The discriminating pair. A resolver that cannot answer "no"
        // is green forever regardless of what the product contains.
        expect(declared.has('pulse')).toBe(true);
        expect(declared.has('definitely-not-a-declared-animation')).toBe(
            false,
        );

        // And the collector must actually collect. An empty Map passes
        // the resolution assertion below vacuously.
        const uses = animateTokenUses();
        expect(uses.size).toBeGreaterThanOrEqual(15);
        expect(uses.has('fadeIn')).toBe(true);
        expect(uses.has('accordion-up')).toBe(true);
        // Comment stripping works: this one survives only as prose in
        // loading-spinner.tsx's docblock, quoting the class it removed.
        expect(uses.has('spinner')).toBe(false);
    });

    it('every animate-* token in src resolves to a declared animation', () => {
        const declared = new Set([
            ...configAnimationNames(),
            ...cssAnimationNames(),
            ...builtinAnimationNames(),
        ]);
        const uses = animateTokenUses();

        const unresolved = [...uses.entries()]
            .filter(([name]) => !declared.has(name))
            .sort(([a], [b]) => a.localeCompare(b));

        if (unresolved.length > 0) {
            const detail = unresolved
                .map(
                    ([name, sites]) =>
                        `  animate-${name} — declared nowhere, used at:\n` +
                        sites
                            .map((s) => `      ${s.file}:${s.line}\n        ${s.snippet}`)
                            .join('\n'),
                )
                .join('\n');
            throw new Error(
                'These `animate-*` classes resolve to NO animation. Tailwind emits ' +
                    'no utility for an animation nobody declared, so the class is ' +
                    'inert and the element renders in its resting state — which ' +
                    'looks deliberate. Declare the animation in ' +
                    '`tailwind.config.js` (`theme.extend.keyframes` + ' +
                    '`theme.extend.animation`), or use one that exists:\n' +
                    detail,
            );
        }
        expect(unresolved).toEqual([]);
    });

    it('globals.css does not redefine the retired keyframe', () => {
        const css = fs.readFileSync(
            path.join(ROOT, 'src/app/globals.css'),
            'utf-8',
        );
        // The @keyframes definition itself was removed; the
        // .animate-slideIn class definition was removed; only the
        // documentation comment remains. The comment uses
        // `slideIn` but isn't an executable rule.
        const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(stripped).not.toMatch(/@keyframes\s+slideIn\b/);
        expect(stripped).not.toMatch(/\.animate-slideIn\s*\{/);
    });
});
