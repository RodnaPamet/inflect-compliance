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
        expect(constants).toMatch(/THEME_STORAGE_KEY\s*=\s*['"]inflect:theme['"]/);
        expect(constants).toMatch(/THEME_COOKIE\s*=\s*['"]inflect_theme['"]/);
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
        expect(src).toMatch(/inflect_theme=\(light\|dark\)/); // cookie read first
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

    it('.btn-* rules consume the shared palette (no raw slate/emerald/red numerics)', () => {
        // Capture the .btn block and assert it no longer uses raw
        // Tailwind color classes from the dark-only palette.
        //
        // THE SECOND BOUND IS INERT AND ALWAYS WAS. `.btn-primary` occurs
        // TWICE (the rule and its `:hover`), so `[1]` already stops at the
        // hover rule — 147 characters — long before the `/* Inputs` comment
        // this line names. Measured byte-identical under `cssCodeOf`, which is
        // the only reason masking the read was safe here: the mask blanks that
        // comment, so a slice that really did depend on it would have silently
        // widened to EOF and taken the two negatives below with it.
        const btnBlock = src.split(/\.btn-primary/)[1]?.split(/\/\* Inputs/)[0] ?? '';
        expect(btnBlock).toMatch(/var\(--/);
        // None of the old raw-class references should survive in the .btn block.
        expect(btnBlock).not.toMatch(/bg-slate-/);
        expect(btnBlock).not.toMatch(/bg-brand-600/);
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
