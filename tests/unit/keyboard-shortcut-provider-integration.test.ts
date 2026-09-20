/**
 * Epic 57 — app-shell integration guardrails for the shared
 * keyboard shortcut system.
 *
 * The audit requires the `KeyboardShortcutProvider` to be a
 * first-class application-shell capability rather than per-page
 * plumbing. That means three invariants the codebase must never drift
 * away from:
 *
 *   1. The server root layout (`src/app/layout.tsx`) mounts the shared
 *      client `<Providers>` wrapper.
 *   2. That `<Providers>` wrapper mounts `<KeyboardShortcutProvider>`
 *      and does so *outside* the rest of the client providers, so the
 *      shortcut registry owns the outermost client boundary.
 *   3. The shortcut module itself is a client file — a stray server
 *      import would break hydration.
 *
 * These are static contract checks, not behavioural tests. They run in
 * the node Jest project so they fire on every CI run without booting
 * jsdom / React.
 */

import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

function read(rel: string): string {
    return codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

describe('KeyboardShortcutProvider — root layout integration', () => {
    it('the server root layout mounts the shared <Providers> wrapper', () => {
        const layout = read('src/app/layout.tsx');
        expect(layout).toContain("import { Providers } from './providers'");
        expect(layout).toMatch(/<Providers>\s*[\s\S]*<\/Providers>/);
    });

    it('<Providers> imports KeyboardShortcutProvider from the canonical module', () => {
        const providers = read('src/app/providers.tsx');
        expect(providers).toMatch(
            /import\s*\{\s*KeyboardShortcutProvider\s*\}\s*from\s*['"]@\/lib\/hooks\/use-keyboard-shortcut['"]/,
        );
    });

    it('<Providers> renders <KeyboardShortcutProvider> in its JSX', () => {
        const providers = read('src/app/providers.tsx');
        expect(providers).toMatch(/<KeyboardShortcutProvider>/);
        expect(providers).toMatch(/<\/KeyboardShortcutProvider>/);
    });

    it('KeyboardShortcutProvider is the OUTERMOST client provider', () => {
        // The shortcut registry installs a single `window.keydown` that
        // every downstream handler is routed through — including the
        // CommandPaletteProvider's own mod+k binding. Mounting any
        // other client provider *above* it would hide keystrokes
        // generated inside those providers from the registry, so we
        // pin the ordering explicitly.
        const providers = read('src/app/providers.tsx');
        const openIdx = providers.indexOf('<KeyboardShortcutProvider>');
        expect(openIdx).toBeGreaterThan(-1);

        const otherProviders = [
            '<CommandPaletteProvider>',
            '<ThemeProvider>',
            '<TooltipProvider>',
            '<Toaster',
        ];
        for (const token of otherProviders) {
            const idx = providers.indexOf(token);
            expect(idx).toBeGreaterThan(openIdx);
        }
    });

    it('CommandPaletteProvider mounts inside KeyboardShortcutProvider', () => {
        // The palette registers `mod+k` on the shared registry, so it
        // must render *under* the registry's provider.
        const providers = read('src/app/providers.tsx');
        const shortcutIdx = providers.indexOf('<KeyboardShortcutProvider>');
        const paletteIdx = providers.indexOf('<CommandPaletteProvider>');
        expect(shortcutIdx).toBeGreaterThan(-1);
        expect(paletteIdx).toBeGreaterThan(shortcutIdx);

        // The surface itself (<CommandPalette />) must be mounted once
        // at the shell so a single portal serves every route.
        expect(providers).toMatch(/<CommandPalette\s*\/>/);
    });

    it('<Providers> is a client component ("use client" directive)', () => {
        const providers = read('src/app/providers.tsx');
        expect(providers.trimStart().startsWith("'use client'")).toBe(true);
    });

    it('the shortcut module itself is a client file', () => {
        const hook = read('src/lib/hooks/use-keyboard-shortcut.tsx');
        expect(hook.trimStart().startsWith("'use client'")).toBe(true);
    });

    it('the shortcut module does not import server-only APIs', () => {
        const hook = read('src/lib/hooks/use-keyboard-shortcut.tsx');
        // next/headers, next/server, fs, path, @/auth, @/env, prisma —
        // any of these imported into a 'use client' file would crash
        // hydration or leak server state.
        const banned = [
            /from\s+['"]next\/headers['"]/,
            /from\s+['"]next\/server['"]/,
            /from\s+['"]fs['"]/,
            /from\s+['"]path['"]/,
            /from\s+['"]@\/auth['"]/,
            /from\s+['"]@\/env['"]/,
            /from\s+['"]@\/lib\/prisma['"]/,
            /from\s+['"]@prisma\/client['"]/,
        ];
        for (const rx of banned) {
            expect(hook).not.toMatch(rx);
        }
    });

    it('the shortcut hook re-exports the canonical module from ui/hooks for back-compat', () => {
        // Existing filter/table/date-picker call sites import
        // `../hooks/use-keyboard-shortcut` or `../hooks`. They must keep
        // resolving to the canonical `@/lib/hooks/use-keyboard-shortcut`
        // implementation rather than the stale Dub copy.
        const shim = read('src/components/ui/hooks/use-keyboard-shortcut.tsx');
        expect(shim).toMatch(
            /export\s*\{[^}]*KeyboardShortcutProvider[^}]*\}\s*from\s*['"]@\/lib\/hooks\/use-keyboard-shortcut['"]/,
        );
        expect(shim).toMatch(
            /export\s*\{[^}]*useKeyboardShortcut[^}]*\}\s*from\s*['"]@\/lib\/hooks\/use-keyboard-shortcut['"]/,
        );
    });
});
