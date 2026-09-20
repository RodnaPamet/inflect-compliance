/**
 * Anti-FOUC theme — no dark→light flash on load / hard navigation.
 *
 * PRIMARY fix: the root layout renders `<html data-theme>` from the persisted
 * theme COOKIE, so a returning user's first SSR byte is already correct — no
 * client script has to win a race against first paint (immune to CSP/nonce/
 * cache races, which is what made the inline-only approach flaky in prod).
 *
 * SECONDARY (first-visit only): a blocking inline <script> in <head> resolves
 * cookie → localStorage → system preference before paint AND writes the cookie
 * so the next SSR is correct. ThemeProvider mirrors theme to BOTH the cookie
 * and localStorage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so a guard can no
// longer be satisfied by a COMMENT naming the thing its assertion is about.
// Applied here rather than per assertion so a new `expect(read(...))` inherits
// it. String literals are KEPT: masking them would silently empty assertions
// that harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike (re-derived per file, not assumed from the directory), so
// `codeOf` is the right lexer and no language split is needed.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));

describe('theme anti-FOUC', () => {
    const layout = read('src/app/layout.tsx');
    const provider = read('src/components/theme/ThemeProvider.tsx');
    const constants = read('src/lib/theme-constants.ts');

    describe('server-safe constants (the proxy-bug fix)', () => {
        // REGRESSION GUARD. Theme constants MUST live in a server-safe module
        // and the SERVER layout MUST import them from there. Importing them from
        // ThemeProvider ('use client') hands the server a client-reference proxy
        // (a function, not the string), which silently broke BOTH the SSR
        // cookie read and the inline script's localStorage key — the bug that
        // made the theme flash on every reload.
        it('theme-constants.ts holds the literal values and is NOT a client module', () => {
            expect(constants).not.toMatch(/^\s*['"]use client['"]/m);
            expect(constants).toMatch(/export const THEME_STORAGE_KEY = 'inflect:theme'/);
            expect(constants).toMatch(/export const THEME_COOKIE = 'inflect_theme'/);
        });

        it('the server layout imports theme constants from the server-safe module, NOT ThemeProvider', () => {
            expect(layout).toMatch(
                /import\s*\{[\s\S]*?\bTHEME_COOKIE\b[\s\S]*?\}\s*from\s*['"]@\/lib\/theme-constants['"]/,
            );
            expect(layout).toMatch(
                /import\s*\{[\s\S]*?\bTHEME_STORAGE_KEY\b[\s\S]*?\}\s*from\s*['"]@\/lib\/theme-constants['"]/,
            );
            // Must NOT pull theme values from the 'use client' provider.
            expect(layout).not.toMatch(
                /import[\s\S]*?THEME_COOKIE[\s\S]*?from\s*['"]@\/components\/theme\/ThemeProvider['"]/,
            );
        });
    });

    describe('primary: SSR data-theme from the cookie (flash-proof)', () => {
        it('renders <html data-theme={initialTheme}> seeded from the theme cookie', () => {
            // The flash-proof guarantee: SSR markup is the persisted theme, not
            // a hardcoded `dark` corrected later by a client script.
            expect(layout).toMatch(/<html lang=\{locale\} data-theme=\{initialTheme\}/);
            expect(layout).toMatch(/cookies\(\)\)\.get\(THEME_COOKIE\)/);
            expect(layout).toMatch(
                /import\s*\{[\s\S]*?\bcookies\b[\s\S]*?\}\s*from\s*['"]next\/headers['"]/,
            );
        });

        it('ThemeProvider persists to the cookie (and re-exports THEME_COOKIE)', () => {
            expect(provider).toMatch(/document\.cookie\s*=\s*`\$\{THEME_COOKIE\}=/);
            expect(provider).toMatch(/function persistTheme/);
            expect(provider).toMatch(/THEME_COOKIE/);
        });
    });

    describe('secondary: pre-paint inline init script', () => {
        it('defines a pre-paint theme init script that sets data-theme', () => {
            expect(layout).toMatch(/THEME_INIT_SCRIPT/);
            expect(layout).toMatch(/setAttribute\('data-theme'/);
            expect(layout).toMatch(/prefers-color-scheme: light/);
        });

        it('reads the SAME keys the provider uses (from the shared server-safe module)', () => {
            expect(layout).toMatch(/THEME_STORAGE_KEY/);
            expect(layout).toMatch(/THEME_COOKIE/);
            expect(constants).toMatch(/THEME_STORAGE_KEY = 'inflect:theme'/);
        });

        it('renders the script in <head> with the CSP nonce, before the body', () => {
            const headIdx = layout.indexOf('<head>');
            const scriptIdx = layout.indexOf('__html: THEME_INIT_SCRIPT');
            const bodyIdx = layout.indexOf('<body');
            expect(headIdx).toBeGreaterThanOrEqual(0);
            expect(scriptIdx).toBeGreaterThan(headIdx);
            expect(scriptIdx).toBeLessThan(bodyIdx);
            // nonce-carrying script (CSP strict-dynamic)
            expect(layout).toMatch(/nonce=\{nonce\}\s*\n\s*suppressHydrationWarning\s*\n\s*dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\}/);
        });
    });
});
