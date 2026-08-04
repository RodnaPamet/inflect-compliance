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

function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Source with comments stripped — prose must never satisfy a ratchet. */
function code(rel: string): string {
    return read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

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
        const block = src.slice(
            src.indexOf('destructive: ['),
            src.indexOf(']', src.indexOf('destructive: [')),
        );
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
        // primary + destructive get theirs from `stillTile` (asserted
        // below); secondary paints its gradient inline, so it needs its
        // own base. `bg-[image:…]` sets background-image; `bg-[var(…)]`
        // sets background-color — both must be present on the variant.
        const block = src.slice(
            src.indexOf('secondary: ['),
            src.indexOf('ghost: ['),
        );
        expect(block).toMatch(/bg-\[image:/);
        expect(block).toMatch(/"bg-\[var\(--bg-muted\)\]"/);
    });

    it('stillTile takes an explicit worst-case base colour', () => {
        expect(src).toMatch(
            /function stillTile\(\s*from: string,\s*to: string,\s*lift: string,\s*base: string,?\s*\)/,
        );
        expect(src).toMatch(/`bg-\[\$\{base\}\]`/);
    });

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
        const src = read(VARIANTS);
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
    const src = read(VARIANTS);

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
