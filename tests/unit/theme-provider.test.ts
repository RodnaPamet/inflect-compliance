/**
 * Epic 51 — theme provider + toggle contract.
 *
 * Jest runs under `testEnvironment: 'node'` so we cannot runtime-load
 * `ThemeProvider.tsx` (tsconfig `jsx: "preserve"`). This suite verifies the
 * observable contract by source inspection — the same pattern used by every
 * other React-layer test in the filter module.
 *
 * Guards:
 *   - ThemeProvider exports the documented hook + provider.
 *   - The storage key, attribute name, and fallback ordering are stable.
 *   - ThemeToggle renders a token-driven icon button with accessible labels.
 *   - The provider mounts inside `<Providers>` so every app page can call
 *     `useTheme()`.
 *   - globals.css legacy `--bg-primary` / `--brand` aliases resolve to the
 *     canonical semantic tokens. That stylesheet is read through `cssCodeOf`,
 *     not `codeOf`: CSS has no `//`, so the TypeScript lexer would have left
 *     every `/* … *\/` comment standing while reading as masked.
 *   - layout.tsx seeds `data-theme` from the persisted theme COOKIE so SSR
 *     and first paint agree without a client-script race (flash-proof);
 *     `dark` is only the no-cookie first-visit fallback.
 */

import * as fs from 'fs';
import { functionBodyOf } from '../helpers/source-blocks';
import { THEME_STORAGE_KEY, THEME_COOKIE } from '@/lib/theme-constants';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../');

import { codeOf, cssCodeOf } from '../helpers/source-blocks';

// #2246 Class A — the mask goes at the READ SEAM so an assertion cannot be
// satisfied by a comment instead of the code it names.
//
// ONE READER PER LANGUAGE, because a mask that lexes the wrong language is
// worse than no mask: it reads as masked at the call site while leaving every
// comment in place. `read` lexes TypeScript (`.ts`/`.tsx`); `readCss` lexes
// CSS, whose only comment form is `/* … */` — which is exactly why `codeOf`
// was the wrong tool for `globals.css` rather than merely an unnecessary one.
//
// This file's header used to say the `.css` masker did not exist and that the
// globals.css read stayed deliberately raw until it did. `cssCodeOf` (#2727)
// is that masker, so the last raw seam here is gone.
function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}
function readCss(rel: string): string {
    return cssCodeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

describe('ThemeProvider — source contract', () => {
    const src = read('src/components/theme/ThemeProvider.tsx');
    const constants = read('src/lib/theme-constants.ts');

    it('is a client module with named exports (no default)', () => {
        expect(src).toMatch(/^'use client'/);
        expect(src).toMatch(/export function ThemeProvider/);
        expect(src).toMatch(/export function useTheme/);
        expect(src).not.toMatch(/^export default/m);
    });

    it('theme keys live in a SERVER-SAFE module (not this client one)', () => {
        // Load-bearing: the server layout imports these; defining them in a
        // 'use client' module hands the server a client-reference proxy, not
        // the string — the bug that broke the SSR cookie read + inline script.
        expect(constants).not.toMatch(/^\s*['"]use client['"]/m);
        // VALUES, not source spellings. These assertions used to regex the
        // constants file, which pinned one way of writing the key rather than
        // the key itself: it would fail on a refactor that preserved the value
        // exactly, and pass on a second constant that shadowed it with a
        // different one. The value is what addresses data already in real users'
        // browsers, so it is the thing worth pinning.
        expect(THEME_STORAGE_KEY).toBe('inflect:theme');
        expect(THEME_COOKIE).toBe('inflect_theme');
        // The provider imports + re-exports them for its client consumers.
        expect(src).toMatch(/from\s*['"]@\/lib\/theme-constants['"]/);
    });

    it('also persists to a cookie so SSR can render the theme flash-free', () => {
        // The cookie (server-readable) is what makes the layout flash-proof;
        // localStorage stays as a back-compat mirror.
        expect(src).toMatch(/document\.cookie\s*=\s*`\$\{THEME_COOKIE\}=/);
        expect(src).toMatch(/function persistTheme\b/);
    });

    it('flips the html[data-theme] attribute (not a class) so tokens.css matches', () => {
        expect(src).toMatch(/ATTR\s*=\s*['"]data-theme['"]/);
        expect(src).toMatch(/setAttribute\(ATTR/);
    });

    it('resolves initial theme in the documented order: cookie → storage → media → dark', () => {
        // The provider builds this regex FROM `THEME_COOKIE` now, so asserting
        // the literal would assert the very drift this change removes. What
        // still matters is the ORDER — the cookie is consulted before storage,
        // because it is what SSR already used.
        //
        // BOUNDED to `readStoredTheme`, not measured across the file. The first
        // version of this assertion compared positions in the whole source and
        // was satisfied by the IMPORT LIST, where the two names appear in the
        // other order — it failed for a reason that had nothing to do with the
        // resolution order it claimed to check.
        const resolve = functionBodyOf(src, 'readStoredTheme');
        expect(resolve.indexOf('THEME_COOKIE')).toBeGreaterThanOrEqual(0);
        expect(resolve.indexOf('STORAGE_KEY')).toBeGreaterThanOrEqual(0);
        expect(resolve.indexOf('THEME_COOKIE')).toBeLessThan(resolve.indexOf('STORAGE_KEY'));
        expect(src).toMatch(/localStorage\.getItem\(STORAGE_KEY\)/);
        expect(src).toMatch(/prefers-color-scheme: light/);
        // Dark is the documented fallback.
        expect(src).toMatch(/return\s+['"]dark['"]/);
    });

    it('`useTheme()` is safe outside a provider (SSR-friendly no-op fallback)', () => {
        // The fallback branch returns a value object with a no-op setter.
        expect(src).toMatch(/setTheme:\s*\(\)\s*=>\s*\{\}/);
        expect(src).toMatch(/toggle:\s*\(\)\s*=>\s*\{\}/);
    });

    it('tolerates localStorage throwing (private/sandboxed contexts)', () => {
        // The module wraps both read and write in try/catch.
        expect(src).toMatch(/catch\s*\{/);
    });
});

describe('ThemeToggle — accessible control', () => {
    const src = read('src/components/theme/ThemeToggle.tsx');

    it('is a client button with aria-label and aria-pressed', () => {
        expect(src).toMatch(/^'use client'/);
        expect(src).toMatch(/aria-label=/);
        expect(src).toMatch(/aria-pressed=/);
    });

    it('swaps the Sun/Moon icon based on the active theme', () => {
        // The component imports both icons from lucide-react and renders one
        // based on the `theme` state. Match both symbols anywhere in the file.
        expect(src).toMatch(/\bSun\b/);
        expect(src).toMatch(/\bMoon\b/);
        expect(src).toMatch(/lucide-react/);
    });

    it('uses the shared .icon-btn token-driven class', () => {
        expect(src).toMatch(/icon-btn/);
    });

    it('carries a deterministic id default and a testid for E2E', () => {
        expect(src).toMatch(/id:\s*string|id\?:\s*string/);
        expect(src).toMatch(/data-testid=["']theme-toggle["']/);
    });
});

describe('Providers wiring — ThemeProvider mounts inside the app shell', () => {
    const providers = read('src/app/providers.tsx');
    it('wraps the NextAuth session boundary', () => {
        expect(providers).toMatch(/from ['"]@\/components\/theme\/ThemeProvider['"]/);
        expect(providers).toMatch(/<ThemeProvider\b/);
    });

    it('root layout seeds data-theme from the persisted cookie (dark fallback)', () => {
        const layout = read('src/app/layout.tsx');
        // Flash-proof: SSR data-theme comes from the cookie, not a hardcoded
        // value; `dark` is only the no-cookie (first-visit) fallback.
        expect(layout).toMatch(/data-theme=\{initialTheme\}/);
        expect(layout).toMatch(/cookies\(\)\)\.get\(THEME_COOKIE\)/);
        expect(layout).toMatch(/:\s*['"]dark['"]/); // ternary fallback
    });
});

describe('globals.css — legacy → semantic alias bridge', () => {
    const src = readCss('src/app/globals.css');

    it('delegates --bg-primary / --text-primary to the semantic tokens', () => {
        expect(src).toMatch(/--bg-primary:\s*var\(--bg-page\)/);
        expect(src).toMatch(/--text-primary:\s*var\(--content-emphasis\)/);
    });

    it('delegates --brand to the semantic brand token', () => {
        expect(src).toMatch(/--brand:\s*var\(--brand-default\)/);
    });

    it('.btn-* CSS classes are retired (#3153 — the family applied to no element)', () => {
        // REPLACES a test that graded the palette inside the `.btn` block
        // ("`.btn-*` rules consume the shared palette"). That block no longer
        // exists: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`,
        // `.btn-success`, `.btn-ghost`, `.btn-xs`, `.btn-sm`, `.btn-lg` and
        // `.btn:focus-visible` were DELETED from globals.css in #3153 after
        // re-measuring that `btn` occurs ZERO times as a whitespace-delimited
        // token inside a `className`/`class` string anywhere in `src/` — the
        // `.btn` → `<Button>` migration finished on 2026-05-08 and
        // `tests/unit/legacy-ui-ratchet.test.ts` has had `BASELINES.btn: 0`
        // ever since.
        //
        // The old test could not survive the deletion and would not have
        // failed usefully: it sliced `src.split(/\.btn-primary/)[1]`, so with
        // the selector gone the slice is `''` and `expect('').toMatch(/var\(--/)`
        // fails with a message about a missing CSS variable rather than about a
        // retired rule family. Same shape as the `.badge` retirement below.
        //
        // Read through `cssCodeOf`, so #3153's long retirement comment in
        // globals.css — which names every one of these selectors — cannot
        // satisfy a negative.
        expect(src).not.toMatch(/^\s*\.btn\b/m);
        expect(src).not.toMatch(/^\s*\.btn\s*\{/m);
        expect(src).not.toMatch(/^\s*\.btn-primary\s*[,{:]/m);
        expect(src).not.toMatch(/^\s*\.btn-(secondary|danger|success|ghost|xs|sm|lg)\s*[,{:]/m);
        // `.icon-btn` is a DIFFERENT, live family and must be untouched — if
        // the negatives above ever start matching it, this positive fails
        // first and says so.
        expect(src).toMatch(/^\s*\.icon-btn\s*\{/m);

        // THE OTHER HALF, and the reason this is one test rather than two: the
        // `--btn-*` CUSTOM PROPERTIES are the live token layer, and deleting
        // them on the strength of the shared `btn` prefix is the mistake the
        // retirement note invites.
        //
        // EXACTLY EIGHT are defined, all in tokens.css, zero in globals.css —
        // and all eight are read at runtime. Both reads are masked through
        // `cssCodeOf` / `codeOf`, so a token or a consumer surviving only as
        // prose cannot satisfy these. That matters here: #3153's brief claimed
        // `control-variants.ts` reads `--btn-ambient-*` and
        // `--btn-iridescent-gradient`, and it does NOT — those tokens were
        // deleted on 2026-07-28
        // (docs/implementation-notes/2026-07-28-retire-dead-button-tokens.md)
        // and all that is left of them in that file is a docblock. Asserting
        // them would have pinned a comment.
        // COUNTS, not `toMatch`, and that is deliberate rather than a style
        // choice. Every one of these tokens is defined TWICE — once in the
        // METRO dark `:root` and once in the PwC light block — so a
        // `toMatch(/--btn-still-top\s*:/)` would be a non-unique needle: delete
        // one theme's definition and the other keeps the assertion green,
        // which is the Class D defect
        // (tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts).
        // "Defined in BOTH themes" is the actual claim, and only a count can
        // make it.
        const tokens = readCss('src/styles/tokens.css');
        const buttonVariants = read('packages/ui/src/components/ui/button-variants.ts');
        const definitions = (token: string): number =>
            (tokens.match(new RegExp(`^\\s*${token}\\s*:`, 'gm')) ?? []).length;
        const reads = (src: string, token: string): number =>
            src.split(`var(${token})`).length - 1;

        const STILL_TOKENS = [
            '--btn-still-top',
            '--btn-still-lift',
            '--btn-still-bot',
            '--btn-still-press',
            '--btn-still-danger',
            '--btn-still-danger-deep',
            '--btn-still-danger-lift',
        ];
        for (const token of STILL_TOKENS) {
            expect({ token, definitions: definitions(token) }).toEqual({
                token,
                definitions: 2,
            });
            expect({ token, readBy: reads(buttonVariants, token) > 0 }).toEqual({
                token,
                readBy: true,
            });
        }
        // The eighth is defined in tokens.css and consumed on the dashboard,
        // not by the Button cva — a different file, so a different assertion.
        expect(definitions('--btn-gradient-primary')).toBe(2);
        expect(
            reads(
                read('src/app/t/[tenantSlug]/(app)/dashboard/PostureHeroCard.tsx'),
                '--btn-gradient-primary',
            ),
        ).toBeGreaterThan(0);

        // And the inverse, so the eight stay a CLOSED set: nothing under
        // src/components/ui reads a `--btn-*` token tokens.css does not
        // define. This is the half that would have caught #3153's brief, which
        // asserted `control-variants.ts` reads `--btn-ambient-*`.
        const referenced = new Set(
            fs
                .readdirSync(path.join(ROOT, 'src/components/ui'))
                .filter((f) => f.endsWith('-variants.ts'))
                .flatMap(
                    (f) =>
                        read(`src/components/ui/${f}`).match(/var\(--btn-[a-z0-9-]+\)/g) ??
                        [],
                )
                .map((m) => m.slice('var('.length, -1)),
        );
        expect(
            [...referenced].filter((token) => definitions(token) === 0),
        ).toEqual([]);
        expect([...referenced].sort()).toEqual([...STILL_TOKENS].sort());
    });

    it('.badge-* CSS classes are retired (PR-2 — every site migrated to <StatusBadge>)', () => {
        // The legacy `.badge` / `.badge-success` / `.badge-warning` /
        // `.badge-danger` / `.badge-info` / `.badge-neutral` CSS classes
        // were deleted from globals.css in PR-2. Every call site now
        // uses `<StatusBadge variant="…">` from
        // `src/components/ui/status-badge.tsx`. Forward enforcement
        // lives in `tests/guards/legacy-badge-eradication.test.ts`.
        //
        // MASKED, AND THAT IS THE RIGHT DIRECTION FOR A NEGATIVE HERE.
        // Blanking a document's PROSE (`mdCodeOf`) or narrowing to a region
        // would let a `.not.toMatch` pass vacuously; a COMMENT mask cannot,
        // because it removes only comments and leaves every rule intact. It
        // closes the mirror-image defect instead: a retired `.badge` rule
        // parked in a `/* … */` block would fail this test while the class is
        // genuinely gone. Mutation-proved by re-adding `.badge { }` as real
        // CSS — red under `cssCodeOf`, so the assertion still has teeth.
        expect(src).not.toMatch(/^\s*\.badge\s*\{/m);
        expect(src).not.toMatch(/^\s*\.badge-success\s*\{/m);
        expect(src).not.toMatch(/^\s*\.badge-danger\s*\{/m);
    });

    it('.glass-card picks up --glass-bg / --glass-border so theme toggle flips glass too', () => {
        expect(src).toMatch(/\.glass-card[^}]*background:\s*var\(--glass-bg\)/);
        expect(src).toMatch(/\.glass-card[^}]*border:\s*1px solid var\(--glass-border\)/);
    });
});
