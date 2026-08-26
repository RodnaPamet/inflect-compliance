#!/usr/bin/env node
/**
 * Vendor the three Swagger-UI assets from `swagger-ui-dist` into
 * `public/swagger-ui/` so `/api/docs` can self-host them instead of
 * loading from the jsdelivr CDN.
 *
 * Why self-host:
 *   - CSP: a strict policy needs only `'self'` for script/style/img;
 *     no `cdn.jsdelivr.net` allowance, no `frame-src` workaround.
 *   - Supply chain: the assets are pinned to the locked
 *     `swagger-ui-dist` version, not whatever the CDN serves.
 *   - Air-gapped: dev/staging behind a firewall work with no egress.
 *
 * The three assets are COMMITTED under `public/swagger-ui/` (they ship
 * in the image via the Dockerfile's `COPY . .` → `COPY public`). This
 * script is the re-vendor tool: run `npm run swagger-ui:vendor` after
 * bumping the `swagger-ui-dist` devDependency, then commit the diff.
 * It is intentionally NOT wired into `postinstall` — that hook is
 * pinned to exactly `patch-package` (locked by
 * tests/e2e/csp-nonce-coverage.spec.ts).
 *
 * Because the re-vendor is manual, forgetting it is the default
 * failure — and it happened, for two months and six bumps (#2125).
 * tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts now
 * fails CI whenever `public/swagger-ui/` is not byte-identical to the
 * installed `swagger-ui-dist`, and tells you to run this script.
 *
 * Plain Node (`.js`, CommonJS — package.json has no `"type"`), not tsx,
 * so it runs with the always-present `node`. If `swagger-ui-dist` isn't
 * installed (e.g. a production `--omit=dev` tree) it SKIPS cleanly.
 *
 * Idempotent: overwrites the three files on every run.
 */
const fs = require('node:fs');
const path = require('node:path');

const ASSETS = [
    'swagger-ui.css',
    'swagger-ui-bundle.js',
    'swagger-ui-standalone-preset.js',
];

function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const destDir = path.join(repoRoot, 'public', 'swagger-ui');

    // Resolve the same way the guard does, rather than hard-coding
    // `<repoRoot>/node_modules`. This repo is routinely checked out into
    // `.claude/worktrees/<id>/`, where the install lives further up the tree —
    // a hard-coded path misses it there, so the guard would report drift while
    // the command it names to fix that drift silently did nothing.
    let srcDir = null;
    try {
        srcDir = path.dirname(require.resolve('swagger-ui-dist/package.json'));
    } catch {
        srcDir = null;
    }

    if (srcDir === null || !fs.existsSync(srcDir)) {
        // This script has exactly one caller: `npm run swagger-ui:vendor`, run
        // deliberately. It is NOT a postinstall hook, so there is no
        // production `--omit=dev` path through here. Somebody asked for a
        // re-vendor and we cannot do it — exiting 0 would report success for
        // work that did not happen, and the guard would keep failing while the
        // fix appeared to run cleanly.
        console.error(
            '[copy-swagger-ui] swagger-ui-dist is not installed, so there is ' +
                'nothing to vendor from. Run `npm ci` (it is a devDependency) ' +
                'and try again.',
        );
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(destDir, { recursive: true });

    let copied = 0;
    for (const asset of ASSETS) {
        const src = path.join(srcDir, asset);
        const dest = path.join(destDir, asset);
        if (!fs.existsSync(src)) {
            console.error(`[copy-swagger-ui] MISSING source asset: ${asset}`);
            process.exitCode = 1;
            continue;
        }
        fs.copyFileSync(src, dest);
        copied++;
    }
    console.log(`[copy-swagger-ui] vendored ${copied}/${ASSETS.length} assets → public/swagger-ui/`);
}

main();
