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

/**
 * The scripts THE SERVER EMITTED, parsed out of the raw HTML.
 *
 * ── WHY THE HTML AND NOT THE DOM (#3506) ────────────────────────────────────
 *
 * The DOM-based assertion below this was flaky, and the measured failures say
 * why. Two runs on 2026-10-14 reported FOUR and then THREE unnonced scripts,
 * one URL common to both, every one of them a `/_next/static/chunks/*.js`. A
 * count that changes between runs of the same build is a count of something
 * being ADDED while the test samples — Next's router injects chunks as it
 * hydrates and prefetches.
 *
 * And a runtime-injected script legitimately carries NO nonce. That is what
 * `'strict-dynamic'` is for: trust propagates from an already-trusted script to
 * the scripts it creates, so requiring a nonce on those asserts something the
 * CSP does not require and the browser does not check.
 *
 * ── WHY THIS IS NOT THE URL EXCLUSION IT LOOKS LIKE ─────────────────────────
 *
 * The obvious fix — skip `/_next/static/chunks/*.js` — would disable this spec
 * for its OWN bug class. The 2026-05-14 production regression was exactly that
 * shape: one `_next/static/chunks/*.js` tag RENDERED without a nonce on every
 * authenticated page, which `strict-dynamic` then blocked. It was blocked
 * precisely because it was parser-inserted rather than created by trusted
 * script, and that is the line this helper draws.
 *
 * So the partition is by ORIGIN, not by URL: a tag in the server's HTML must
 * carry a nonce, whatever it points at. A script only in the DOM was created at
 * runtime and is covered by `strict-dynamic` instead.
 *
 * ── IT IS ALSO THE DISCRIMINATOR #3506 ASKED FOR ────────────────────────────
 *
 * The issue named two readings — a racing test, or a nonce genuinely missing
 * sometimes — and said nothing separated them. This does, and WITHOUT needing
 * me to be right about which one applies: if those chunk URLs turn out to be in
 * the server HTML after all, they are still asserted here and this still fails.
 * The restructure moves the question from "did it flake?" to "which set was it
 * in?", which the failure output now prints.
 *
 * Parsed with a regex rather than a DOM parse because the whole point is to
 * read the bytes the server sent, before anything executes. `page.request`
 * shares the browser context's cookie jar, so this is the same authenticated
 * response the page itself got.
 */
async function serverEmittedScripts(
    page: import('@playwright/test').Page,
    url: string,
): Promise<ScriptInfo[]> {
    const res = await page.request.get(url);
    expect(res.ok(), `GET ${url} for the raw HTML: ${res.status()}`).toBe(true);
    const html = await res.text();
    return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => {
        const tag = m[0];
        const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? null;
        return {
            src,
            type: /\btype="([^"]*)"/i.exec(tag)?.[1] ?? null,
            hasNonce: /\bnonce="[^"]*"/i.test(tag),
            snippet: (src ?? tag).slice(0, 90),
        };
    });
}

test.describe('CSP nonce coverage on authenticated pages', () => {
    test('every script the SERVER EMITS on the dashboard carries a nonce', async ({ page }) => {
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/dashboard`);

        const emitted = await serverEmittedScripts(page, `/t/${slug}/dashboard`);

        // Sanity: a page with no scripts would pass vacuously, and the app
        // renders dozens. The original bug was ONE unnonced tag out of 55.
        expect(emitted.length).toBeGreaterThan(5);

        expect(unnonced(emitted).map((s) => s.snippet)).toEqual([]);
    });

    test('and the runtime-injected ones are reported, not asserted — the partition is visible', async ({
        page,
    }) => {
        // THE HALF THAT KEEPS THE CHANGE HONEST. Narrowing the assertion above
        // to server-emitted scripts is only safe while two things hold, and
        // both are checked rather than assumed:
        //
        //   1. `'strict-dynamic'` is in the CSP — pinned by the last test in
        //      this file, which is what makes an unnonced RUNTIME script allowed
        //      and an unnonced PARSER-INSERTED one blocked.
        //   2. The runtime set is not where the server's own tags went. If the
        //      nonce plumbing broke by moving tags out of the HTML, the
        //      server-emitted count would collapse and the test above would fail
        //      on its `> 5` floor rather than passing over an empty set.
        //
        // So this test asserts the SHAPE of the partition and prints it. It does
        // not assert that runtime scripts carry nonces, because under
        // strict-dynamic they need not.
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/dashboard`);

        const inDom = await collectScripts(page);
        const emitted = await serverEmittedScripts(page, `/t/${slug}/dashboard`);
        const emittedSrcs = new Set(emitted.map((s) => s.src).filter(Boolean));
        const runtimeOnly = inDom.filter((s) => s.src && !emittedSrcs.has(s.src));

        // The DOM must be a SUPERSET of what the server sent — if it is not, the
        // two reads are not describing the same page and nothing below means
        // anything.
        expect({
            domCount: inDom.length >= emitted.length,
            emittedCount: emitted.length > 5,
        }).toEqual({ domCount: true, emittedCount: true });

        // Printed, not asserted: this is the set #3506's flake lived in. Four
        // then three on two runs of the same build, all `_next/static/chunks`.
        console.log(
            `[csp-nonce] server-emitted ${emitted.length}, dom ${inDom.length}, ` +
                `runtime-only ${runtimeOnly.length}` +
                (runtimeOnly.length
                    ? ` — unnonced among them: ${unnonced(runtimeOnly).length}`
                    : ''),
        );
    });

    test('and on a data-heavy list page, where the chunk split differs', async ({ page }) => {
        // The 2026-05-14 regression came from a per-component chunk, so the
        // page that loads the most distinct chunks is the one most likely to
        // surface it. Controls is the reference DataTable page.
        const slug = await loginAndGetTenant(page);
        await safeGoto(page, `/t/${slug}/controls`);

        const emitted = await serverEmittedScripts(page, `/t/${slug}/controls`);
        expect(emitted.length).toBeGreaterThan(5);
        expect(unnonced(emitted).map((s) => s.snippet)).toEqual([]);
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
