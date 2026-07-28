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

    it('has no pseudo-element layers — depth is painted on the element', () => {
        expect(src).not.toMatch(/\bbefore:/);
        expect(src).not.toMatch(/\bafter:/);
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
