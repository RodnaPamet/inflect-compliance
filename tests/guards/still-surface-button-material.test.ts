import { buttonVariants } from '@/components/ui/button-variants';

import { braceBlockAfter, codeOf } from '../helpers/source-blocks';
/**
 * STILL SURFACE — the canonical button-material ratchet (2026-07-28).
 *
 * Supersedes and replaces sixteen retired epic guards (R19-PR-D,
 * R20-PR-A…F, R22-PR-A…D, R24-PR-B…F, button-press-feedback). Those
 * pinned the carbon / aura / iridescent / liquid-glass stack layer by
 * layer; every one of their assertions is now false BY DESIGN, so
 * they were retired rather than weakened. This file is the single
 * place the button material is locked.
 *
 * It guards three things:
 *
 *   1. MOTIONLESSNESS — the defining property. The material's whole
 *      claim is that feedback and animation are different things, so
 *      the banned-class list below is the contract, not a style
 *      preference.
 *
 *   2. THE CANONICAL FOUR — primary | secondary | ghost |
 *      destructive. No fifth shape, no drift. (The complementary
 *      `button-variant-cull` ratchet bans the retired NAMES at call
 *      sites; this one locks the catalogue at the source.)
 *
 *   3. THE SINGLE-RUNG LADDER — every size key resolves to the same
 *      28px geometry, and the form-control scale moves in lockstep so
 *      filter toolbars stay aligned.
 *
 * Durable invariants inherited from the retired guards and preserved
 * here: pill radius, coarse-pointer touch target, two-channel
 * disabled mute, a focus indicator, icon shrink-0, and the
 * primary-label contrast token.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// Arrow consts, not function declarations: the Class A/D analyser follows the
// `const read = (p) => …` / `const code = (p) => codeOf(read(p))` shape
// (assertion-reach.ts:1164) and does NOT resolve a delegating function
// declaration, which leaves every read through it un-analysable — a blind spot
// the uniqueness ratchet counts against a zero-allowance ceiling.
const read = (rel: string): string =>
    fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with comments stripped — prose must never satisfy a ratchet.
 *
 * #2246 — this was hand-rolled and is now `codeOf`, the repo's masker. The old
 * pair of `.replace` calls was not fail-closed: the line-comment pattern ate
 * from ANY double-slash to end of line, including one inside a string such as
 * a URL, and both calls DELETED text rather than blanking it, so every offset
 * shifted. `codeOf` keeps string literals and preserves length and line count.
 *
 * `read` deliberately stays RAW: it also serves `src/styles/tokens.css`, and
 * `codeOf` lexes TypeScript, not CSS.
 */
const code = (rel: string): string => codeOf(read(rel));

const VARIANTS = 'src/components/ui/button-variants.ts';
const BUTTON = 'src/components/ui/button.tsx';
const CONTROLS = 'src/components/ui/control-variants.ts';
const HIT_AREA = 'src/components/ui/hit-area.ts';
const FILTER_TOOLBAR = 'src/components/filters/FilterToolbar.tsx';

describe('Still Surface — motionless by construction', () => {
    const src = code(VARIANTS);

    it('declares the three motion kill-switches in the cva base', () => {
        expect(src).toMatch(/"transition-none"/);
        expect(src).toMatch(/\[animation:none\]/);
        expect(src).toMatch(/\[transform:none\]/);
    });

    // Each entry is a specific mechanism the previous material used to
    // build depth out of movement. The `why` is surfaced in the failure
    // so a future contributor reintroducing one knows what they are
    // undoing rather than just seeing a regex fail.
    const BANNED: ReadonlyArray<{ rx: RegExp; what: string; why: string }> = [
        {
            rx: /transition-all/,
            what: 'transition-all',
            why: 'the base transition — every state must land on the pointer frame',
        },
        {
            rx: /active:scale-/,
            what: 'active:scale-*',
            why: 'the 3% press shrink (R11-PR4)',
        },
        {
            rx: /active:translate-y/,
            what: 'active:translate-y-*',
            why: 'the 1px press travel (R20-PR-D)',
        },
        {
            rx: /before:transition/,
            what: 'before:transition-*',
            why: 'the ::before hover fade (R19-PR-C/D)',
        },
        {
            rx: /after:transition/,
            what: 'after:transition-*',
            why: 'the ::after aura transition (R20-PR-B)',
        },
        {
            rx: /hover:after:shadow-/,
            what: 'hover:after:shadow-*',
            why: 'the aura bloom on hover (R20-PR-B)',
        },
        {
            rx: /backdrop-blur/,
            what: 'backdrop-blur-*',
            why: 'unnecessary once the fill is graded (R24 glass)',
        },
        {
            rx: /motion-reduce:/,
            what: 'motion-reduce:*',
            why: 'nothing moves, so there is nothing for reduced-motion to strip',
        },
    ];

    it.each(BANNED.map((b) => [b.what, b] as const))(
        'never reintroduces `%s`',
        (_label, entry) => {
            if (entry.rx.test(src)) {
                throw new Error(
                    `\`${entry.what}\` is back in ${VARIANTS} — that was ${entry.why}. ` +
                        'Still Surface builds depth from static light + a hue ' +
                        'trade; reintroducing motion breaks the material contract.',
                );
            }
            expect(entry.rx.test(src)).toBe(false);
        },
    );

    it('has no pseudo-element MATERIAL — depth is painted on the element', () => {
        // The original rule banned `before:` / `after:` outright, because
        // every pseudo-element the R19→R24 stack used was a paint layer:
        // a hover fade, an aura bloom, a glass meniscus. That is still
        // banned — but the ban is on MATERIAL, not on the mechanism.
        //
        // One non-painting pseudo-element is now allowed and asserted
        // below: the `::before` hit area that gives a `rounded-full`
        // button its square box back for hover purposes. It carries no
        // colour, no shadow, no filter and no transition, so it cannot
        // reintroduce depth-through-motion by any route.
        const PAINTING_PSEUDO = [
            /before:bg-/, /after:bg-/,
            /before:shadow/, /after:shadow/,
            /before:opacity/, /after:opacity/,
            /before:backdrop/, /after:backdrop/,
            /before:blur/, /after:blur/,
            /before:border-\[/, /after:border-\[/,
        ];
        for (const rx of PAINTING_PSEUDO) {
            expect({ rx: String(rx), hit: rx.test(src) }).toEqual({
                rx: String(rx),
                hit: false,
            });
        }
        // `::after` stays entirely unused — nothing needs a second layer.
        expect(src).not.toMatch(/\bafter:/);
    });

    it('keeps the hit area square so a pill has no dead corners', () => {
        // Measured before this landed: 16% of a 28px icon button's own box
        // (the four corner arcs) rendered as button but did not answer to
        // `:hover`, so a diagonal approach left the pointer visibly on the
        // tile with the hover off — and a small wiggle across the arc
        // toggled it. Dropping the layer brings the dead corners back.
        const recipe = code(HIT_AREA);
        expect(recipe).toMatch(/before:content-\['']/);
        expect(recipe).toMatch(/before:absolute/);
        // The border box, not the padding box — `inset-0` leaves the 1px
        // border ring dead, which measured WORSE than no fix at all (an
        // arc plus a square edge is four wiggle crossings, not two).
        expect(recipe).toMatch(/before:-inset-px/);
        expect(recipe).not.toMatch(/before:inset-0/);
        // Square, not pill — inheriting the radius would restore the very
        // dead zone this exists to remove.
        expect(recipe).toMatch(/before:rounded-none/);
        expect(recipe).not.toMatch(/before:rounded-full/);
        // …and the button actually wears it.
        expect(src).toMatch(/HIT_AREA_CLASS/);
        // The element must stay a positioning context, or the offsets
        // resolve against an ancestor and the hit area detaches.
        expect(src).toMatch(/"relative"/);
    });

    it('every rounded control recipe shares the ONE hit area', () => {
        // The pill button was not the only offender — the probe found the
        // same dead corners on the topbar bell (14%), the tenant switcher
        // (3%), the view toggle (5%) and the filter trigger (2%). They are
        // hand-rolled recipes rather than `buttonVariants` consumers, so
        // each has to opt in explicitly. Adding a new rounded control?
        // Import `HIT_AREA_CLASS` rather than growing a second recipe.
        const CONSUMERS = [
            'src/components/ui/button-variants.ts',
            'src/components/ui/toggle-group.tsx',
            'src/components/ui/filter/filter-select.tsx',
            'src/components/layout/notifications-bell.tsx',
        ];
        for (const rel of CONSUMERS) {
            expect({ rel, uses: code(rel).includes('HIT_AREA_CLASS') }).toEqual({
                rel,
                uses: true,
            });
        }
    });

    it('no consumer clips its own hit area', () => {
        // `overflow: hidden` — which Tailwind's `truncate` sets — clips the
        // pseudo-element back to the rounded padding box and silently
        // restores the dead corners. The filter trigger shipped exactly
        // that bug: 1% dead and FOUR hover flips per corner wiggle while
        // looking, in source, like it had the fix.
        const CLIPPERS = /\btruncate\b|\boverflow-hidden\b/;
        const FILES = [
            'src/components/ui/button-variants.ts',
            'src/components/ui/toggle-group.tsx',
            'src/components/ui/filter/filter-select.tsx',
            'src/components/layout/notifications-bell.tsx',
        ];
        for (const rel of FILES) {
            const src = code(rel);
            const at = src.indexOf('HIT_AREA_CLASS', src.indexOf('HIT_AREA_CLASS') + 1);
            // Window around the class list that carries the hit area.
            const window = src.slice(Math.max(0, at - 400), at + 200);
            expect({ rel, clipped: CLIPPERS.test(window) }).toEqual({
                rel,
                clipped: false,
            });
        }
    });
});

describe('Still Surface — the reciprocal hover edge', () => {
    const src = code(VARIANTS);

    it('primary trades its edge for the complementary hue on hover + press', () => {
        expect(src).toMatch(
            /hover:border-\[var\(--brand-secondary-default\)\]/,
        );
        expect(src).toMatch(
            /active:border-\[var\(--brand-secondary-default\)\]/,
        );
    });

    it('secondary takes the BRAND edge — the mirror of primary', () => {
        expect(src).toMatch(/hover:border-\[var\(--brand-default\)\]/);
    });

    it('destructive keeps its own danger stops and never borrows the reciprocity', () => {
        // A destructive action must not adopt the brand's hover language
        // and read as routine.
        //
        // #3084 — the window used to be bounded by the first `]` AFTER
        // `destructive: [`, which was the array's own closing bracket only
        // for as long as the variant's classes came from `stillTile(...)`.
        // Now that they are written out, `bg-[var(--btn-still-danger)]`
        // closes a bracket on the FIRST line, so that bound collapsed the
        // window to a few characters and the negated assertion below became
        // very nearly vacuous — it would have stayed green with
        // `--brand-secondary-default` added anywhere past the opening line.
        // Bound on the `variant: { … }` object's own braces instead and take
        // everything from the last variant key to its end.
        const variantBlock = braceBlockAfter(src, 'variant:\\s*\\{');
        const block = variantBlock.slice(
            variantBlock.indexOf('destructive: ['),
        );
        // The bound has to be WIDE as well as correct: a collapsed window
        // passes `not.toMatch` for free.
        expect(block.length).toBeGreaterThan(400);
        expect(block).toMatch(/--btn-still-danger/);
        expect(block).not.toMatch(/--brand-secondary-default/);
    });

    it('the reciprocal hue is defined in BOTH themes', () => {
        const tokens = read('src/styles/tokens.css');
        const hits = tokens.match(/--brand-secondary-default:/g) ?? [];
        expect(hits.length).toBeGreaterThanOrEqual(2);
    });

    it('the Still Surface token suite exists in both themes', () => {
        const tokens = read('src/styles/tokens.css');
        for (const t of [
            '--btn-still-top',
            '--btn-still-bot',
            '--btn-still-lift',
            '--btn-still-press',
        ]) {
            const hits = tokens.match(new RegExp(`${t}:`, 'g')) ?? [];
            expect({ token: t, count: hits.length }).toEqual({ token: t, count: 2 });
        }
    });
});

describe('Still Surface — contrast floors (WCAG AA)', () => {
    // A gradient tile painted only with `background-image` gives a contrast
    // checker nothing to resolve, so axe walks up to the page background and
    // measures the label against THAT. On primary that read as navy-on-navy
    // and failed the a11y gate on every page. Every gradient variant must
    // therefore also declare a solid `background-color`.
    const src = code(VARIANTS);

    it('secondary declares a solid background-color under its gradient', () => {
        // Every gradient variant needs its own base; `bg-[image:…]` sets
        // background-image and `bg-[var(…)]` sets background-color, so both
        // must be present on the variant.
        const block = src.slice(
            src.indexOf('secondary: ['),
            src.indexOf('ghost: ['),
        );
        expect(block).toMatch(/bg-\[image:/);
        expect(block).toMatch(/"bg-\[var\(--bg-muted\)\]"/);
    });

    // #3084 — this pair used to read
    //
    //     expect(src).toMatch(/function stillTile\(…base: string…\)/);
    //     expect(src).toMatch(/`bg-\[\$\{base\}\]`/);
    //
    // which asserted the base colour was an explicit PARAMETER of a helper
    // and that the helper built the class by INTERPOLATING it. Both halves
    // were true and the invariant they named — "the tile declares a solid
    // background-color" — was false in the shipped CSS, because Tailwind
    // never evaluates a function and so never saw the class. The ratchet
    // pinned the defect's mechanism in place. It now asserts the property
    // instead: each tile variant writes its own worst-case base literally.
    it.each([
        // variant, where its block ends, the base token it must declare
        ['primary', 'secondary: [', 'var(--brand-emphasis)'],
        ['destructive', null, 'var(--btn-still-danger)'],
    ] as const)(
        '%s declares its worst-case base colour as a literal class',
        (key, nextKey, base) => {
            const variantBlock = braceBlockAfter(src, 'variant:\\s*\\{');
            const from = variantBlock.indexOf(`${key}: [`);
            expect(from).toBeGreaterThanOrEqual(0);
            const to = nextKey
                ? variantBlock.indexOf(nextKey)
                : variantBlock.length;
            const block = variantBlock.slice(from, to);
            expect(block.length).toBeGreaterThan(400);

            // The solid background-color, written out so Tailwind sees it.
            expect({ key, base: block.includes(`"bg-[${base}]"`) }).toEqual({
                key,
                base: true,
            });

            // …and it is one of the stops this tile actually paints, not a
            // flattering midpoint. The rest gradient is the only class on the
            // variant that names both stops, so find it and look inside.
            const restGradient = block
                .split('\n')
                .find((l) => l.includes('"bg-[image:'));
            expect(typeof restGradient).toBe('string');
            expect({ key, stop: (restGradient ?? '').includes(base) }).toEqual({
                key,
                stop: true,
            });
        },
    );

    // Relative luminance / contrast per WCAG 2.x. Kept inline so the
    // ratchet is self-contained and the numbers are auditable here.
    function luminance(hex: string): number {
        const h = hex.replace('#', '');
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
        const f = (c: number) =>
            c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }
    function contrast(a: string, b: string): number {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    }

    const tokens = read('src/styles/tokens.css');
    function tokenValue(name: string, nth: number): string {
        const all = Array.from(
            tokens.matchAll(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`, 'g')),
        ).map((m) => m[1]);
        return all[nth];
    }

    // The proposal's original dark danger stops (#F87171 / #E14A4A) were
    // red-400 TEXT colours used as a FILL behind a white label — 2.77:1 and
    // 3.98:1. They were deepened to the red-600/700 family. This locks the
    // floor so a future "restore the original reds" PR fails here rather
    // than in the a11y gate.
    it.each([
        ['dark', 0],
        ['light', 1],
    ])('destructive danger stops clear 4.5:1 against white (%s theme)', (_theme, nth) => {
        for (const name of [
            '--btn-still-danger',
            '--btn-still-danger-deep',
            '--btn-still-danger-lift',
        ]) {
            const hex = tokenValue(name, nth as number);
            expect(typeof hex).toBe('string');
            expect({ token: name, passes: contrast('#FFFFFF', hex) >= 4.5 }).toEqual({
                token: name,
                passes: true,
            });
        }
    });
});

describe('Still Surface — the canonical four variants', () => {
    it('declares exactly primary | secondary | ghost | destructive', () => {
        // #2246 — was `read(VARIANTS)`, the one site in this file that took the
        // RAW text of a TypeScript source while its three siblings used the
        // masked reader. A commented-out variant could satisfy it.
        const src = code(VARIANTS);
        const block =
            src.match(/variant:\s*\{([\s\S]*?)\},\s*size:/)?.[1] ?? '';
        const declared = Array.from(
            block.matchAll(/^\s*"?([a-z][a-z-]*)"?\s*:\s*\[/gm),
        ).map((m) => m[1]);
        expect(declared.sort()).toEqual(
            ['destructive', 'ghost', 'primary', 'secondary'].sort(),
        );
    });

    it('no `destructive-outline` survives anywhere in the app source', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules') continue;
                    walk(full);
                } else if (/\.tsx?$/.test(e.name)) {
                    const body = fs
                        .readFileSync(full, 'utf8')
                        .replace(/\/\*[\s\S]*?\*\//g, '')
                        .replace(/\/\/[^\n]*/g, '');
                    if (/destructive-outline/.test(body)) {
                        offenders.push(path.relative(ROOT, full));
                    }
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(offenders).toEqual([]);
    });
});

describe('Still Surface — the single-rung ladder', () => {
    const src = code(VARIANTS);

    const RUNG = /h-7 px-\[0\.7rem\] text-\[0\.76rem\]/;

    it.each(['xs', 'sm', 'md', 'lg'])(
        'size "%s" resolves to the same 28px geometry',
        (key) => {
            const line =
                src.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"`, 'm'))?.[1] ??
                '';
            expect({ key, line }).toEqual({ key, line: expect.stringMatching(RUNG) });
        },
    );

    it('the icon rung is square at the same height', () => {
        expect(src).toMatch(/icon:\s*"h-7 w-7/);
    });

    it('the disabled mirror in button.tsx matches the rung', () => {
        // This branch bypasses the cva variant entirely (cn-only
        // fallback), so a drift here shows up as a disabled button that
        // is a different SIZE from its enabled self.
        const btn = code(BUTTON);
        const mirrors = btn.match(/h-7 px-\[0\.7rem\] text-\[0\.76rem\]/g) ?? [];
        expect(mirrors.length).toBe(2);
    });

    it('form controls move in lockstep so toolbars stay aligned', () => {
        // The whole reason controlSize exists. A 28px button beside a
        // 36px input is the visible failure this locks out.
        const ctrl = code(CONTROLS);
        expect(ctrl).toMatch(/CONTROL_RUNG\s*=\s*"h-7 /);
        for (const key of ['xs', 'sm', 'md', 'lg']) {
            expect(ctrl).toMatch(new RegExp(`${key}:\\s*CONTROL_RUNG`));
        }
    });

    it('the Filter trigger takes its size from the rung, not a hand-set height', () => {
        // The lockstep above is only worth anything if the toolbar
        // actually USES it. FilterToolbar hard-coded `className="h-9"`
        // (36px) on the Filter trigger while `primary` beside it is a
        // 28px <Button> — the precise mismatch control-variants.ts says
        // the scale exists to prevent, sitting in the one component that
        // renders both. Fixed 2026-08-04.
        const toolbar = code(FILTER_TOOLBAR);
        expect(toolbar).toMatch(/className=\{controlSize\.\w+\}/);
        // No hand-set height may come back on the trigger.
        expect(toolbar).not.toMatch(/className="h-\d+"/);
    });
});

describe('Still Surface — durable invariants inherited from the retired guards', () => {
    const src = code(VARIANTS);

    it('keeps the pill radius (B3 canonicalisation)', () => {
        expect(src).toMatch(/rounded-full/);
    });

    it('keeps the coarse-pointer 44px touch target (WCAG 2.5.5)', () => {
        // The one reason collapsing every button to 28px is safe on
        // touch: min-h only RAISES, so the tap target never shrinks
        // with the visual.
        expect(src).toMatch(/pointer-coarse:min-h-11/);
        expect(src).toMatch(/pointer-coarse:min-w-11/);
    });

    it('keeps the two-channel disabled mute (opacity + saturation)', () => {
        expect(src).toMatch(/disabled:opacity-45/);
        expect(src).toMatch(/disabled:saturate-50/);
    });

    it('keeps a visible focus indicator', () => {
        expect(src).toMatch(/focus-visible:shadow-\[/);
        expect(src).toMatch(/focus-visible:outline-none/);
    });

    it('keeps icon shrink-0 (R22-PR-C icon discipline)', () => {
        expect(src).toMatch(/\[&_svg\]:shrink-0/);
    });

    it('keeps the primary label on the inverted contrast token (B10)', () => {
        // White on METRO-yellow was a low-contrast wash; the inverted
        // token is the semantic text-on-brand colour.
        expect(src).toMatch(/text-content-inverted/);
    });
});

/**
 * Still Surface — every class the variants EMIT is one Tailwind can SEE.
 *
 * Tailwind does not evaluate code. It scans source TEXT for candidate class
 * names, so a class assembled at runtime — from a template literal, a
 * helper's return value, a `cn()` of fragments — reaches the DOM but never
 * reaches the stylesheet, and the element is then styled by a rule that does
 * not exist. There is no build error and no warning; the button simply paints
 * nothing where the missing rule would have painted.
 *
 * #3084 was exactly that. `stillTile(from, to, lift, base)` returned
 * `bg-[${base}]`, `border-[${to}]` and three interpolated `linear-gradient(…)`
 * strings. Measured on a real CSS build of `src/app/globals.css`: ELEVEN of
 * the fourteen classes the two tile variants emit had no rule in the output.
 * `destructive` rendered with no fill at all — a white label on the white UA
 * background in the light theme — and `primary` looked roughly right only
 * because `bg-[var(--brand-emphasis)]` happens to be written literally in ten
 * other components. Every ratchet above was green throughout.
 *
 * So the check has to start from what the function RETURNS, not from what the
 * source looks like: evaluate the real `buttonVariants` and require each class
 * to be written, delimited, in a file Tailwind's `content` glob covers. No
 * prettier abstraction can satisfy it, because the property Tailwind needs
 * genuinely is "this exact string appears in the source".
 */
describe('Still Surface — the emitted classes exist in the stylesheet (#3084)', () => {
    // `content: ['./src/**/*.{js,ts,jsx,tsx,mdx}']` — tailwind.config.js. There
    // is no `safelist` and globals.css adds no `@source`, so this glob is the
    // whole of what Tailwind reads.
    const SCANNED = /\.(?:js|ts|jsx|tsx|mdx)$/;

    /**
     * Every scanned file's CODE, concatenated — comments blanked.
     *
     * Blanking comments makes this STRICTER than Tailwind, which scans raw
     * text and therefore does read them. The asymmetry is deliberate and was
     * found the hard way: the first mutation proof of this ratchet — putting
     * destructive's base class back into the interpolated form the issue
     * describes — did NOT turn it red, because the docstring added above the
     * fix names `bg-[var(--btn-still-danger)]` while EXPLAINING the bug. That
     * prose was a one-line invisible safelist and it held the guard green
     * with the defect fully restored. A class mentioned in a comment is one
     * copy-edit from vanishing, so a mention must not count as a
     * declaration: the repo's standing rule that prose may never satisfy a
     * ratchet, applied in the one place where the scanner being modelled
     * disagrees.
     */
    const scannedText: string = (() => {
        const parts: string[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules') continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (SCANNED.test(e.name)) {
                    parts.push(codeOf(fs.readFileSync(full, 'utf8')));
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        // A separator no candidate can span, so a class cannot be assembled
        // out of the tail of one file and the head of the next. `\0` is the
        // ESCAPE for the same byte that used to sit here raw — raw, it made
        // this 32 KB file binary to POSIX tooling, so a `grep` of it printed
        // zero matches instead of an error (#3161). Keep the NUL: `'\n\n'`
        // happens to behave identically, because PART_OF_CANDIDATE already
        // excludes `\n`, but dropping it would remove a belt and leave the
        // sentence above describing code that no longer exists.
        return parts.join('\n\0\n');
    })();

    /**
     * Is `cls` written in the scanned tree as a candidate IN ITS OWN RIGHT?
     *
     * Not a bare substring test. `group-hover:bg-[var(--brand-muted)]` is
     * written in button.tsx and CONTAINS `hover:bg-[var(--brand-muted)]` —
     * a DIFFERENT candidate, generating a different rule. The first pass at
     * this measurement was `grep -F`, which reported the short form present
     * on the strength of the long one; the CSS build disagreed, and the CSS
     * build was right. `bg-[var(--x)]/70` swallows `bg-[var(--x)]` the same
     * way. So an occurrence only counts when neither neighbour could be part
     * of the same candidate.
     *
     * Nor a split-the-tree-into-tokens test, which was the second pass and
     * was also wrong: `before:content-['']` carries quote characters, so
     * splitting on quotes shredded it and the check reported a class that is
     * demonstrably IN the built CSS as missing.
     */
    const PART_OF_CANDIDATE = /[A-Za-z0-9_:\-./]/;
    const isWritten = (cls: string): boolean => {
        for (
            let i = scannedText.indexOf(cls);
            i >= 0;
            i = scannedText.indexOf(cls, i + 1)
        ) {
            const prev = i > 0 ? scannedText[i - 1] : '\n';
            const next = scannedText[i + cls.length] ?? '\n';
            if (!PART_OF_CANDIDATE.test(prev) && !PART_OF_CANDIDATE.test(next)) {
                return true;
            }
        }
        return false;
    };

    it('the check can say YES (positive control)', () => {
        // A read that silently came back empty — a renamed directory, a
        // changed glob — would report every class as invisible, and the test
        // names would not say so.
        expect(scannedText.length).toBeGreaterThan(1_000_000);
        expect(isWritten('rounded-full')).toBe(true);
        expect(isWritten('bg-[var(--brand-emphasis)]')).toBe(true);
        // Carries quote characters. This is the one that caught the
        // tokenising version of this check out.
        expect(isWritten("before:content-['']")).toBe(true);
    });

    it('the check can say NO, and is not fooled by a longer candidate', () => {
        // Written nowhere and a substring of nothing written.
        expect(scannedText.includes('bg-[var(--no-such-token-3084)]')).toBe(
            false,
        );
        expect(isWritten('bg-[var(--no-such-token-3084)]')).toBe(false);

        // The substring trap, with both halves asserted so the control
        // cannot quietly stop discriminating: the long form is written, the
        // fragment of it is PRESENT IN THE TEXT, and the check must still
        // reject the fragment.
        expect(isWritten('group-hover:bg-[var(--brand-muted)]')).toBe(true);
        expect(scannedText.includes('oup-hover:bg-[var(--brand-muted)]')).toBe(
            true,
        );
        expect(isWritten('oup-hover:bg-[var(--brand-muted)]')).toBe(false);
    });

    it.each(['primary', 'secondary', 'ghost', 'destructive'] as const)(
        'every class `%s` emits is written literally in a scanned file',
        (variant) => {
            const emitted = buttonVariants({ variant })
                .split(/\s+/)
                .filter(Boolean);
            // A variant that emitted nothing would satisfy the filter below
            // vacuously. Measured 37–40 per variant when this landed.
            expect(emitted.length).toBeGreaterThanOrEqual(30);

            const invisible = emitted.filter((c) => !isWritten(c));
            expect({ variant, invisible }).toEqual({ variant, invisible: [] });
        },
    );

    it('button-variants.ts builds no class by interpolation', () => {
        // The SHAPE of the defect rather than its instances, so the next one
        // fails on the line that introduces it instead of in a variant's
        // emitted list. A class that has to be computed belongs in
        // `tokens.css` as a custom property, not in a template literal.
        const raw = code(VARIANTS);
        expect(raw).not.toMatch(/\$\{/);
    });

    it('every `var(--…)` the variants reference is defined in tokens.css', () => {
        // The OTHER way to paint nothing, and the check above cannot see it.
        // `isWritten` asks whether Tailwind generates a rule for the class,
        // which it does for `border-[var(--btn-still-danger-deeper)]` — the
        // rule is emitted, the custom property resolves to nothing, and the
        // declaration is dropped. Same blank tile, no class missing from the
        // CSS, so a typo in a TOKEN name is invisible to every other
        // assertion in this file. Measured: mutating one token reference left
        // all 46 of them green.
        //
        // Derived from the source, with no exception list — a token that
        // genuinely lives elsewhere should fail this and be argued with.
        const refs = [
            ...new Set(
                Array.from(
                    code(VARIANTS).matchAll(/var\((--[a-z0-9-]+)\)/g),
                ).map((m) => m[1]),
            ),
        ].sort();
        // A regex that stopped matching would make the loop below vacuous.
        expect(refs.length).toBeGreaterThanOrEqual(12);

        const tokens = read('src/styles/tokens.css');
        const undefinedRefs = refs.filter(
            (t) => !new RegExp(`^\\s*${t}:`, 'm').test(tokens),
        );
        expect(undefinedRefs).toEqual([]);
    });
});
