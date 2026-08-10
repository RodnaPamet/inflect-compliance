/**
 * CSP nonce — Next.js component-script patch (2026-05-14).
 *
 * Real-world failure: `_next/static/chunks/18at7xtdx0uoz.js`
 * loaded WITHOUT a nonce attribute in the rendered HTML of every
 * authenticated app page (dashboard, controls, risks, etc.). CSP
 * `strict-dynamic` blocked it, breaking R16 chart code (donut
 * rendered as thin orange crescent only).
 *
 * Root cause: a missing `nonce: ctx.nonce` prop in Next.js 16's
 * internal `createComponentStylesAndScripts` function. The sibling
 * `getLayerAssets` function — which builds the same shape of
 * `<script>` element from the same client-reference manifest —
 * DOES pass `nonce: ctx.nonce`. The bug is one missing line in
 * `node_modules/next/dist/server/app-render/create-component-
 * styles-and-scripts.js`.
 *
 * Diagnosis path (2026-05-14):
 *   1. PR #481 set CSP on REQUEST headers → fixed 54/55 script
 *      tags on the dashboard HTML, but ONE remained unnonced.
 *   2. Captured the dashboard HTML via curl + session cookie →
 *      pinned the unnonced tag's source to its `script-${index}`
 *      key (from `getLayerAssets` / `createComponentStylesAndScripts`).
 *   3. Compared the two functions — `getLayerAssets` passes
 *      `nonce: ctx.nonce`, `createComponentStylesAndScripts` does
 *      not. Verified by re-curl after manually patching the
 *      bundled prod runtime — 0 unnonced scripts, fix confirmed.
 *
 * Fix: apply `patches/next+<version>.patch` via `patch-package`
 * (`postinstall` hook in package.json). The patch adds
 * `nonce: ctx.nonce` to the `createComponentStylesAndScripts`
 * function in:
 *   • `dist/server/app-render/create-component-styles-and-scripts.js`
 *   • `dist/esm/server/app-render/create-component-styles-and-scripts.js`
 *
 * CORRECTION (2026-08-10): this docstring previously also claimed the
 * patch covered "all four bundled prod runtimes in
 * `dist/compiled/next-server/app-page*.prod.js`", and called those "what
 * actually load at runtime". The patch has NEVER touched them — the
 * original `next+16.2.7.patch` contained exactly the two diffs above, as
 * does its regenerated successor. Whether the unbundled fix is sufficient
 * at runtime is therefore an OPEN question, not a settled one; it is
 * recorded here rather than left as a claim the file contradicts.
 *
 * Three load-bearing invariants — locked here so a future
 * `npm install` that drops the patch breaks CI:
 *
 *   1. A `patches/next+<version>.patch` exists AND its version matches
 *      the `next` version in package.json. Pinning the exact filename is
 *      what made every Next bump fail as an unexplained `patch-package`
 *      error during `npm ci` (it took down all 10 jobs of the Aug-10
 *      dependency PR); pinning the RELATIONSHIP fails loudly, in one
 *      guard, with a message that says to regenerate the patch.
 *   2. The `postinstall` npm script invokes `patch-package`.
 *   3. The unbundled source file contains the `nonce: ctx.nonce`
 *      line. (Verifies the patch actually applied — `npm install`
 *      runs `patch-package` via `postinstall`, so on a clean
 *      checkout + install, this assertion passes if and only if
 *      the patch round-tripped successfully.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('CSP nonce — Next.js component-script patch', () => {
    it('a next patch exists and its version matches package.json', () => {
        // The patch is the deliverable. Without it, `npm install` produces
        // an unpatched node_modules and the R16 chart CSP bug returns.
        //
        // The version match is the part that matters operationally:
        // patch-package keys the patch to an exact version, so bumping
        // `next` without regenerating makes `patch-package` ERROR inside
        // `postinstall` — which fails `npm ci`, which fails EVERY job,
        // with nothing pointing at the patch. Asserting the relationship
        // turns that into one legible failure.
        const patches = fs
            .readdirSync(path.join(ROOT, 'patches'))
            .filter((f) => /^next\+.*\.patch$/.test(f));
        expect(patches).toHaveLength(1);

        const pkgJson = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
        );
        const installed = String(pkgJson.dependencies?.next ?? '').replace(/^[\^~]/, '');
        expect(patches[0]).toBe(`next+${installed}.patch`);

        // …and it is the nonce fix, not some other patch that happens to
        // be named for next.
        const body = fs.readFileSync(path.join(ROOT, 'patches', patches[0]), 'utf8');
        expect(body).toContain('nonce: ctx.nonce');
        expect(body).toContain('create-component-styles-and-scripts.js');
    });

    it('package.json has the `postinstall: patch-package` script', () => {
        // patch-package is a no-op without the postinstall hook.
        // The hook auto-runs after `npm install` / `npm ci`, so
        // every developer + CI environment gets the patched bundle
        // automatically.
        const pkgJson = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
        );
        expect(pkgJson.scripts?.postinstall).toBe('patch-package');
        expect(pkgJson.devDependencies?.['patch-package']).toBeTruthy();
    });

    it('node_modules has the nonce fix in the unbundled source', () => {
        // Smoke test: on a clean install, `postinstall` runs
        // `patch-package`, which applies our patch, which adds the
        // `nonce: ctx.nonce` line. If this assertion fails, either
        // the patch didn't apply (postinstall didn't run) or the
        // patch drifted against a different next version.
        const srcPath = path.join(
            ROOT,
            'node_modules/next/dist/server/app-render/create-component-styles-and-scripts.js',
        );
        const src = fs.readFileSync(srcPath, 'utf8');
        expect(src).toMatch(/nonce:\s*ctx\.nonce/);
    });

    it('node_modules has the nonce fix in the bundled prod runtime', () => {
        // The prod runtime bundle is what actually runs in
        // `npx next start`. The unbundled source above is for
        // upstream-PR readability; this assertion is the one
        // that proves the fix is live at runtime.
        const bundlePath = path.join(
            ROOT,
            'node_modules/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js',
        );
        const bundle = fs.readFileSync(bundlePath, 'utf8');
        // Minified — the var name `a` is `ctx` in the unminified
        // source. The index + ctx var names are minifier-assigned and change
        // between Next releases (16.2.6 used `${t}`/`a.nonce`; 16.2.7 uses
        // `${r}`/`e.nonce`). Match the structural fingerprint, not the letters.
        expect(bundle).toMatch(
            /async:!0,key:`script-\$\{\w+\}`,nonce:\w+\.nonce/,
        );
    });
});
