/**
 * The Swagger UI bytes a browser executes must be the bytes of the
 * `swagger-ui-dist` version this repo declares.
 *
 * `/api/docs` self-hosts three `swagger-ui-dist` assets out of
 * `public/swagger-ui/`. Those files are COMMITTED (they ship in the
 * image via the Dockerfile's `COPY public`), and the only thing that
 * regenerates them is a MANUAL `npm run swagger-ui:vendor` —
 * `postinstall` is pinned to exactly `patch-package`, and nothing in
 * `build`, CI or the Dockerfile re-runs the vendor script.
 *
 * So a dependency bump moves `package.json` and leaves the served bytes
 * untouched, silently. That is not hypothetical: the assets were
 * vendored at 5.17.14 on 2026-06-26 and six subsequent bumps carried the
 * declared version to 5.32.14 while the browser kept receiving 5.17.14 —
 * two months, ~100 KB of divergence on the bundle alone, and no
 * mechanism anywhere that could report it (issue #2125).
 *
 * The consequence is not untidiness. `npm audit` — which this repo
 * blocks on at MODERATE+ — reads `package.json`; the browser reads
 * `public/`. While those disagree the gate is answering a question about
 * software nobody is running.
 *
 * This guard closes the loop end to end:
 *
 *     declared (package.json) == installed (node_modules) == served (public/)
 *
 * The first link catches a hand-edited `package.json`; the second
 * catches a bump landing without a re-vendor. Both must hold, because
 * either one alone is satisfiable while the browser still gets stale
 * code.
 *
 * Fixing a failure is one command: `npm run swagger-ui:vendor`, then
 * commit `public/swagger-ui/`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const VENDOR_DIR = path.join(ROOT, 'public', 'swagger-ui');
const ROUTE_FILE = path.join(ROOT, 'src', 'app', 'api', 'docs', 'route.ts');
const SCRIPT_FILE = path.join(ROOT, 'scripts', 'copy-swagger-ui.js');

const REVENDOR = 'Run `npm run swagger-ui:vendor` and commit public/swagger-ui/.';

function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Where `swagger-ui-dist` actually lives, via Node's own resolution
 * starting at the repo root. NOT a hard-coded `<root>/node_modules/…`:
 * this repo is routinely checked out into `.claude/worktrees/<id>/`,
 * where the install lives further up the tree, and a guard that reports
 * "not installed" there would be a false failure of exactly the kind
 * that teaches people to ignore it.
 */
const DIST_DIR: string | null = (() => {
    try {
        return path.dirname(require.resolve('swagger-ui-dist/package.json', { paths: [ROOT] }));
    } catch {
        return null;
    }
})();

/** The resolved dist dir, or a failure naming the fix. */
function distDir(): string {
    if (DIST_DIR === null) {
        throw new Error(
            'swagger-ui-dist is not installed, so the served assets cannot be compared ' +
                'against the version this repo declares. Run `npm install`.',
        );
    }
    return DIST_DIR;
}

/** Asset filenames the docs route actually points a browser at. */
function assetsReferencedByRoute(): string[] {
    const src = fs.readFileSync(ROUTE_FILE, 'utf8');
    // Only the `const … = '/swagger-ui/x'` declarations, so the prose in
    // the file header can neither satisfy nor trip this on its own.
    const found = [...src.matchAll(/^const\s+\w+\s*=\s*'\/swagger-ui\/([^']+)';$/gm)].map(
        (m) => m[1],
    );
    return [...new Set(found)].sort();
}

/** Asset filenames the vendor script copies. */
function assetsCopiedByScript(): string[] {
    const src = fs.readFileSync(SCRIPT_FILE, 'utf8');
    const block = /const ASSETS = \[([\s\S]*?)\];/.exec(src);
    if (!block) throw new Error(`Could not find the ASSETS list in ${SCRIPT_FILE}`);
    return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

/** Files actually committed under public/swagger-ui/. */
function assetsCommitted(): string[] {
    return fs.readdirSync(VENDOR_DIR).sort();
}

function declaredVersion(): string {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    };
    const v = pkg.devDependencies?.['swagger-ui-dist'] ?? pkg.dependencies?.['swagger-ui-dist'];
    if (!v) throw new Error('swagger-ui-dist is not a declared dependency of this repo');
    return v;
}

function installedVersion(): string {
    return (
        JSON.parse(fs.readFileSync(path.join(distDir(), 'package.json'), 'utf8')) as {
            version: string;
        }
    ).version;
}

describe('vendored Swagger UI matches the declared swagger-ui-dist', () => {
    it('has swagger-ui-dist installed to compare against', () => {
        // Deliberately a failure, not a skip. A skipped comparison and a
        // passing one are indistinguishable in a CI log, and this guard
        // exists precisely because "nothing reported a problem" was read
        // as "there is no problem".
        expect(fs.existsSync(path.join(distDir(), 'package.json'))).toBe(true);
    });

    it('serves exactly the assets the vendor script copies, and no others', () => {
        const referenced = assetsReferencedByRoute();
        const copied = assetsCopiedByScript();
        const committed = assetsCommitted();

        // A non-empty reference set proves the route parse worked, so the
        // set comparisons below cannot pass vacuously.
        expect(referenced.length).toBeGreaterThan(0);

        // Anything the route links but the script never copies 404s in the
        // browser; anything committed but unreferenced ships dead weight
        // into the image.
        expect(copied).toEqual(referenced);
        expect(committed).toEqual(referenced);
    });

    it('declares the swagger-ui-dist version that is actually installed', () => {
        // An exact pin (no ^ or ~) is the existing convention for this dep
        // and is what makes "declared == served" a meaningful claim.
        expect(declaredVersion()).toBe(installedVersion());
    });

    it.each(assetsReferencedByRoute())(
        'serves %s byte-for-byte from the installed swagger-ui-dist',
        (asset) => {
            const served = path.join(VENDOR_DIR, asset);
            const installed = path.join(distDir(), asset);

            expect(fs.existsSync(served)).toBe(true);
            expect(fs.existsSync(installed)).toBe(true);

            const servedHash = sha256(served);
            const installedHash = sha256(installed);

            if (servedHash !== installedHash) {
                throw new Error(
                    `public/swagger-ui/${asset} is NOT the ${installedVersion()} asset it is ` +
                        `declared to be — the browser gets different bytes than npm audit ` +
                        `evaluates.\n` +
                        `  served    ${fs.statSync(served).size} B  sha256 ${servedHash}\n` +
                        `  installed ${fs.statSync(installed).size} B  sha256 ${installedHash}\n` +
                        `${REVENDOR}`,
                );
            }
        },
    );
});
