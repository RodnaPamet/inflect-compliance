/**
 * CSP `strict-dynamic` + webpack chunk loader bridge (2026-05-14).
 *
 * Real-world failure: a CSP violation on
 * `_next/static/chunks/*.js` blocked the R16 chart code from
 * loading on production. The donut rendered partially because
 * the dynamic-import chunks for visx/motion never reached the
 * page.
 *
 * Root cause: Next.js auto-stamps its server-rendered `<script>`
 * and `<link>` tags with the request nonce, but webpack's
 * runtime injects chunk `<script>` tags later via
 * `document.createElement('script')`. Those don't get the nonce
 * unless webpack's `__webpack_nonce__` global is set.
 *
 * The bridge: inject an inline `<script nonce={nonce}>` in the
 * root layout's `<head>` that sets `__webpack_nonce__` on both
 * `window` and `globalThis` before any chunk loads. Webpack then
 * reads the global and applies the same nonce to every chunk it
 * injects — satisfying `strict-dynamic`.
 *
 * Three load-bearing invariants:
 *
 *   1. The root layout renders a `<script>` inside `<head>` that
 *      sets `__webpack_nonce__`. Inside `<head>` is load-bearing
 *      — it must execute before any chunk is requested.
 *
 *   2. The script carries `nonce={nonce}` so CSP allows it.
 *      Without the nonce, the script itself is blocked and the
 *      whole bridge fails before it starts.
 *
 *   3. Sets BOTH `window.__webpack_nonce__` and
 *      `globalThis.__webpack_nonce__`. Stricter SSR-adjacent
 *      runtimes (workers, isolates) may only expose one or the
 *      other; covering both is the safe shape.
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
const LAYOUT_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/app/layout.tsx'),
    'utf8',
));

describe('CSP `strict-dynamic` webpack nonce bridge', () => {
    it('renders a <head> block in the root layout', () => {
        // Without an explicit <head>, Next.js auto-generates one
        // but we can't inject the bridge script there.
        expect(LAYOUT_SRC).toMatch(/<head>/);
        expect(LAYOUT_SRC).toMatch(/<\/head>/);
    });

    it('emits an inline <script> with the nonce + dangerouslySetInnerHTML', () => {
        // The bridge must be inline (not external) — external
        // would need a separate nonce'd request, defeating the
        // point. dangerouslySetInnerHTML carries the inline body.
        expect(LAYOUT_SRC).toMatch(
            /<script[\s\S]*?nonce=\{nonce\}[\s\S]*?dangerouslySetInnerHTML=/,
        );
    });

    it('sets window.__webpack_nonce__', () => {
        // The webpack global for chunk-loader nonce propagation.
        // Without this, dynamic-import chunks load without the
        // nonce and CSP strict-dynamic blocks them.
        expect(LAYOUT_SRC).toMatch(/window\.__webpack_nonce__\s*=/);
    });

    it('sets globalThis.__webpack_nonce__ for stricter runtimes', () => {
        // Worker-adjacent runtimes (edge isolates, web workers)
        // may only expose globalThis. Belt-and-braces.
        expect(LAYOUT_SRC).toMatch(/globalThis\.__webpack_nonce__\s*=/);
    });

    it('the bridge script is conditional on nonce being present', () => {
        // The bridge fires only when middleware has set a nonce.
        // In environments without CSP (some test harnesses), the
        // bridge silently noops.
        expect(LAYOUT_SRC).toMatch(/\{nonce\s*&&\s*\(/);
    });

    it('uses JSON.stringify to embed the nonce value (escapes safely)', () => {
        // Direct string interpolation would let a nonce containing
        // `'` or `<` break out of the JS context. JSON.stringify
        // is the standard safe-embed pattern.
        expect(LAYOUT_SRC).toMatch(/JSON\.stringify\(nonce\)/);
    });
});
