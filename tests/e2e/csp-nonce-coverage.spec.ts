/**
 * Every `<script>` on an authenticated page carries a nonce.
 *
 * ## Why this replaced a source-scanning guard
 *
 * The regression this protects against is real and was seen in production
 * (2026-05-14): one `_next/static/chunks/*.js` tag rendered WITHOUT a nonce on
 * every authenticated page, CSP `strict-dynamic` blocked it, and the R16 donut
 * chart rendered as a thin orange crescent.
 *
 * It used to be guarded by `tests/guards/csp-nonce-component-scripts-patch.test.ts`,
 * which asserted that a `patch-package` patch was present and that a compiled
 * Next bundle contained `nonce:`. That guard was deleted, because every one of
 * its assertions was satisfiable without the fix being live:
 *
 *   - it read `app-page-turbo.runtime.prod.js`, a bundle production never
 *     loads (`next start` with TURBOPACK unset loads `app-page.runtime.prod.js`);
 *   - its `nonce:` regex matched `getLayerAssets`, a sibling function upstream
 *     already nonces — so it passed against a file byte-identical to stock npm;
 *   - the patch it required had two hunks, both on UNBUNDLED sources that the
 *     app-page route module never requires.
 *
 * It was, in other words, a mechanism ratchet that validated the diagnosis
 * rather than the remedy. This spec validates the remedy: it asserts the
 * property users actually depend on, and it fails when that property breaks
 * regardless of which file, bundle or build flag happens to carry the fix.
 *
 * ## What actually keeps this green today
 *
 * `next build --webpack` (2026-06-05). Webpack's client-reference manifests do
 * not populate `entryJSFiles`, so the function that omitted the nonce emits no
 * script elements at all. That is a build-flag property, not a code fix — which
 * is precisely why this needs a behavioural test. Moving back to Turbopack, or
 * an upstream change that starts emitting `entryJSFiles` under webpack, would
 * bring the unnonced tag back silently.
 *
 * @see docs/implementation-notes/2026-08-18-csp-nonce-patch-removal.md
 */
import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';

/**
 * Scripts a nonce is NOT expected on.
 *
 * `type="application/json"` and `type="application/ld+json"` are data blocks,
 * not executable script, and CSP does not apply to them. Everything else must
 * carry one.
 */
const NON_EXECUTABLE_TYPES = ['application/json', 'application/ld+json', 'importmap', 'speculationrules'];

interface ScriptInfo {
    src: string | null;
    type: string | null;
    hasNonce: boolean;
    snippet: string;
}

async function collectScripts(page: import('@playwright/test').Page): Promise<ScriptInfo[]> {
    return page.$$eval('script', (nodes) =>
        nodes.map((n) => {
            const el = n as HTMLScriptElement;
            return {
                src: el.getAttribute('src'),
                type: el.getAttribute('type'),
                // `nonce` is deliberately read via getAttribute AND the property.
                // Browsers hide the attribute after CSP application (the nonce is
                // moved to an internal slot), so an attribute-only read reports
                // false for scripts that DID carry one.
                hasNonce: Boolean(el.getAttribute('nonce') || el.nonce),
                snippet: (el.getAttribute('src') || el.textContent || '').slice(0, 90),
            };
        }),
    );
}

function unnonced(scripts: ScriptInfo[]): ScriptInfo[] {
    return scripts.filter(
        (s) => !s.hasNonce && !NON_EXECUTABLE_TYPES.includes((s.type || '').toLowerCase()),
    );
}

test.describe('CSP nonce coverage on authenticated pages', () => {
    test('every executable script on the dashboard carries a nonce', async ({ page }) => {
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/dashboard`);

        const scripts = await collectScripts(page);

        // Sanity: a page with no scripts would pass vacuously, and the app
        // renders dozens. The original bug was ONE unnonced tag out of 55.
        expect(scripts.length).toBeGreaterThan(5);

        expect(unnonced(scripts).map((s) => s.snippet)).toEqual([]);
    });

    test('and on a data-heavy list page, where the chunk split differs', async ({ page }) => {
        // The 2026-05-14 regression came from a per-component chunk, so the
        // page that loads the most distinct chunks is the one most likely to
        // surface it. Controls is the reference DataTable page.
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/controls`);

        const scripts = await collectScripts(page);
        expect(scripts.length).toBeGreaterThan(5);
        expect(unnonced(scripts).map((s) => s.snippet)).toEqual([]);
    });

    test('the CSP header itself still requires a nonce, so the assertions above mean something', async ({ page }) => {
        // If script-src ever loses its nonce requirement, every assertion in
        // this file keeps passing while the protection is gone. Pin the header.
        const slug = await loginAndGetTenant(page);
        const res = await page.goto(`/t/${slug}/dashboard`);
        const csp =
            res?.headers()['content-security-policy'] ??
            res?.headers()['content-security-policy-report-only'] ??
            '';

        expect(csp).toContain('script-src');
        expect(csp).toMatch(/'nonce-[^']+'/);
        // strict-dynamic is what makes an unnonced STATIC tag fail rather than
        // fall back to a host allowlist.
        expect(csp).toContain("'strict-dynamic'");
    });
});
