/**
 * API-docs coverage ratchet.
 *
 * `/api/docs` is the interactive reference for external API consumers
 * (partner SDK authors, customers integrating with Inflect). This guard
 * locks in the four fixes that made it usable:
 *
 *   1. `public/openapi.json` is POPULATED with route paths (was 0 →
 *      now the full route surface, critical set + stubs).
 *   2. The spec declares `components.securitySchemes` so Swagger UI
 *      shows an Authorize button.
 *   3. Swagger UI assets are SELF-HOSTED (`/swagger-ui/`), not loaded
 *      from a CDN — kills the CSP / supply-chain / air-gap problems.
 *   4. `docs/api-consumer-guide.md` documents the consumer contract.
 *
 * A regression on any of these makes the docs route worse for external
 * consumers, so each is asserted structurally.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Comments are masked at the read seam for SOURCE files, so a comment
// mentioning a symbol can never satisfy an assertion about code. JSON and
// markdown are read raw — `//` there is content (URLs, prose), not a comment.
const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs|prisma)$/;
const read = (p: string) => {
    const raw = fs.readFileSync(path.join(ROOT, p), 'utf8');
    return CODE_FILE.test(p) ? codeOf(raw) : raw;
};
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

// Current path count is 431 (591 operations). Floor well below that so
// route churn doesn't cause false failures, but far above the 50-path
// minimum from the spec — a floor of 300 proves the route-walker ran
// and the spec is not back to the 26-path critical-only state.
const PATHS_FLOOR = 300;

interface OpenApiDoc {
    paths?: Record<string, Record<string, { 'x-stub'?: boolean; 'x-required-permission'?: string }>>;
    components?: { securitySchemes?: Record<string, unknown> };
    security?: Array<Record<string, unknown>>;
}

describe('API docs coverage', () => {
    describe('public/openapi.json is populated', () => {
        const spec = JSON.parse(read('public/openapi.json')) as OpenApiDoc;
        const paths = spec.paths ?? {};
        const pathKeys = Object.keys(paths);

        it(`has more than ${PATHS_FLOOR} paths (was 0 before this work)`, () => {
            expect(pathKeys.length).toBeGreaterThan(PATHS_FLOOR);
        });

        it('still carries the richly-documented critical set (x-required-permission)', () => {
            const withPermission = pathKeys.flatMap((p) =>
                Object.values(paths[p]).filter((op) => op['x-required-permission']),
            );
            expect(withPermission.length).toBeGreaterThan(20);
        });

        it('carries stub entries for non-critical routes (x-stub)', () => {
            const stubs = pathKeys.flatMap((p) =>
                Object.values(paths[p]).filter((op) => op['x-stub']),
            );
            expect(stubs.length).toBeGreaterThan(100);
        });

        it('declares components.securitySchemes with at least one scheme', () => {
            const schemes = spec.components?.securitySchemes ?? {};
            expect(Object.keys(schemes).length).toBeGreaterThanOrEqual(1);
            // The canonical partner flow is a Bearer API key.
            expect(schemes).toHaveProperty('BearerAuth');
        });

        it('declares a top-level security requirement', () => {
            expect(Array.isArray(spec.security)).toBe(true);
            expect((spec.security ?? []).length).toBeGreaterThanOrEqual(1);
        });
    });

    describe('Swagger UI assets are self-hosted (no CDN)', () => {
        const route = read('src/app/api/docs/route.ts');

        it('route.ts references /swagger-ui/ paths', () => {
            expect(route).toMatch(/\/swagger-ui\/swagger-ui\.css/);
            expect(route).toMatch(/\/swagger-ui\/swagger-ui-bundle\.js/);
            expect(route).toMatch(/\/swagger-ui\/swagger-ui-standalone-preset\.js/);
        });

        it('route.ts does NOT load assets from cdn.jsdelivr.net', () => {
            // Source-text check. Built from parts + counted via split() so
            // it isn't mistaken for runtime URL validation (CodeQL
            // js/incomplete-url-substring-sanitization / missing-regexp-anchor
            // both fire on a hostname literal tested against a URL-ish string).
            const cdnMarker = ['cdn', 'jsdelivr', 'net'].join('.');
            expect(route.split(cdnMarker)).toHaveLength(1);
        });

        it('public/swagger-ui/ exists with the three vendored assets', () => {
            // Committed to the repo (re-vendored via scripts/copy-swagger-ui.js).
            for (const asset of [
                'swagger-ui.css',
                'swagger-ui-bundle.js',
                'swagger-ui-standalone-preset.js',
            ]) {
                expect(exists(path.join('public/swagger-ui', asset))).toBe(true);
            }
        });

        it('the re-vendor script + pinned dependency exist', () => {
            expect(exists('scripts/copy-swagger-ui.js')).toBe(true);
            const pkg = JSON.parse(read('package.json')) as {
                scripts: Record<string, string>;
                devDependencies: Record<string, string>;
            };
            // Maintainer re-vendor entrypoint (NOT postinstall — that's
            // pinned to patch-package by the csp-nonce guard).
            expect(pkg.scripts['swagger-ui:vendor']).toMatch(/copy-swagger-ui\.js/);
            expect(pkg.devDependencies['swagger-ui-dist']).toBeDefined();
        });
    });

    describe('docs/api-consumer-guide.md', () => {
        const guide = exists('docs/api-consumer-guide.md') ? read('docs/api-consumer-guide.md') : '';

        it('exists', () => {
            expect(exists('docs/api-consumer-guide.md')).toBe(true);
        });

        it('covers the five required sections', () => {
            // 1. /api/docs vs /openapi.json
            expect(guide).toMatch(/openapi\.json/);
            expect(guide).toMatch(/\/api\/docs/);
            // 2. Authentication
            expect(guide).toMatch(/Authentication|authenticate/i);
            expect(guide).toMatch(/Bearer|API key/);
            // 3. Rate limiting
            expect(guide).toMatch(/Rate limit/i);
            expect(guide).toMatch(/Retry-After/);
            // 4. Versioning
            expect(guide).toMatch(/Versioning/i);
            expect(guide).toMatch(/semver|info\.version/i);
            // 5. Error contract
            expect(guide).toMatch(/Error contract/i);
            expect(guide).toMatch(/requestId/);
            expect(guide).toMatch(/\bcode\b/);
        });
    });
});
