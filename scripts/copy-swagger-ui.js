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
    const srcDir = path.join(repoRoot, 'node_modules', 'swagger-ui-dist');
    const destDir = path.join(repoRoot, 'public', 'swagger-ui');

    if (!fs.existsSync(srcDir)) {
        // Production install (--omit=dev) or a checkout without deps.
        // /api/docs is 404 in production, so this is a no-op, not an error.
        console.log(
            '[copy-swagger-ui] swagger-ui-dist not installed — skipping ' +
                '(expected in production --omit=dev installs).',
        );
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
