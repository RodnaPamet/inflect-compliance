/**
 * CSP request header bridge — Next.js auto-nonce wiring (2026-05-14).
 *
 * Real-world failure: even with the `__webpack_nonce__` bridge in
 * the root layout (PR #480), the CSP violation
 * `_next/static/chunks/*.js` violates ... strict-dynamic` persisted
 * on the deployed dashboard. R16's visx + motion dynamic imports
 * stayed blocked.
 *
 * Root cause: Next.js 15 reads the FULL `Content-Security-Policy`
 * value from the REQUEST headers to drive its internal auto-nonce
 * propagation. It uses the nonce from there to stamp:
 *   • Chunk-preload `<link>` tags in the document head
 *   • Webpack runtime chunk-loader `<script>` tags
 *
 * Our middleware was setting CSP only on the RESPONSE headers
 * (browser enforcement) — Next.js's internal machinery had no
 * way to discover the policy at SSR time, so it didn't apply the
 * nonce, so `strict-dynamic` blocked the chunks.
 *
 * The canonical Next.js middleware pattern in the official docs
 * sets the policy as a REQUEST header. Without that, the
 * developer-side `__webpack_nonce__` global is shouting at thin
 * air because Next's chunk loader never reads it (chunks are
 * already blocked at the preload level).
 *
 * Three load-bearing invariants:
 *
 *   1. The middleware sets the CSP value on the REQUEST headers
 *      using `requestHeaders.set(cspHeaderName, cspHeader)`. The
 *      header name matches the response (Content-Security-Policy
 *      OR Content-Security-Policy-Report-Only depending on the
 *      CSP_REPORT_ONLY env flag).
 *
 *   2. The same value is also set on the RESPONSE headers
 *      (browser enforcement). Both must coexist.
 *
 *   3. The header is set on the modified `requestHeaders` Headers
 *      object that gets forwarded via
 *      `NextResponse.next({ request: { headers: requestHeaders } })`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const MIDDLEWARE_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/middleware.ts'),
    'utf8',
));

describe('CSP request header bridge — Next.js auto-nonce wiring', () => {
    it('middleware sets the CSP value on the REQUEST headers object', () => {
        // The load-bearing fix. Next.js's auto-nonce machinery
        // reads the request CSP header at SSR time to extract the
        // nonce and stamp chunk-preload links + script tags.
        expect(MIDDLEWARE_SRC).toMatch(
            /requestHeaders\.set\(\s*cspHeaderName\s*,\s*cspHeader\s*\)/,
        );
    });

    it('middleware still sets the CSP value on the RESPONSE headers', () => {
        // Browser-side enforcement. Without this, the policy
        // isn't applied even if Next.js generates correct nonces
        // — the browser doesn't know about the policy.
        expect(MIDDLEWARE_SRC).toMatch(
            /res\.headers\.set\(\s*cspHeaderName\s*,\s*cspHeader\s*\)/,
        );
    });

    it('uses the same `cspHeaderName` variable for both request + response', () => {
        // The header name varies between
        // `Content-Security-Policy` (enforce) and
        // `Content-Security-Policy-Report-Only` (report-only).
        // Using the same `cspHeaderName` variable for both
        // keeps the modes in sync — a request header in enforce
        // mode + a response header in report-only mode would
        // produce undefined behaviour.
        const requestSet = MIDDLEWARE_SRC.match(
            /requestHeaders\.set\(\s*cspHeaderName\s*,/,
        );
        const responseSet = MIDDLEWARE_SRC.match(
            /res\.headers\.set\(\s*cspHeaderName\s*,/,
        );
        expect(requestSet).not.toBeNull();
        expect(responseSet).not.toBeNull();
    });

    it('forwards the modified requestHeaders via NextResponse.next', () => {
        // Without `request: { headers: requestHeaders }`, Next.js
        // sees the ORIGINAL request headers (no CSP header), so
        // the auto-nonce machinery still misses.
        expect(MIDDLEWARE_SRC).toMatch(
            /NextResponse\.next\(\s*\{\s*request:\s*\{\s*headers:\s*requestHeaders\s*\}\s*\}\s*\)/,
        );
    });
});
