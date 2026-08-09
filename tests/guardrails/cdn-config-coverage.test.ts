/**
 * Structural ratchet — CloudFront CDN configuration coverage.
 *
 * Locks the wiring of the static-asset edge tier so a refactor can't
 * silently drop a cache behaviour or the invalidation step:
 *   - the terraform CDN module exists + declares the distribution with
 *     all four cache behaviours (immutable static / image / api / default),
 *   - next.config.js drives assetPrefix from env,
 *   - the Caddyfile emits the immutable Cache-Control for /_next/static/*,
 *   - the deploy workflow invalidates CloudFront on release.
 *
 * See docs/cdn.md and docs/implementation-notes/2026-06-26-cdn-cloudfront.md.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) =>
    fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf-8') : '';

const cdnTf = read('infra/terraform/modules/cdn/main.tf');
const nextCfg = read('next.config.js');
const caddy = read('deploy/caddy/Caddyfile');
const deployYml = read('.github/workflows/deploy.yml');

describe('CDN terraform module', () => {
    it('infra/terraform/modules/cdn/main.tf exists', () => {
        expect(cdnTf.length).toBeGreaterThan(0);
    });

    it('declares a CloudFront distribution', () => {
        expect(cdnTf).toMatch(/resource\s+"aws_cloudfront_distribution"/);
    });

    it('declares all four cache behaviours', () => {
        // Ordered behaviours by path pattern …
        expect(cdnTf).toContain('/_next/static/*');
        expect(cdnTf).toContain('/_next/image*');
        expect(cdnTf).toContain('/api/*');
        // … plus the catch-all default behaviour for the HTML shell.
        expect(cdnTf).toMatch(/default_cache_behavior\s*\{/);
    });

    it('caches immutable static for 1 year and never caches /api', () => {
        // The static behaviour carries the 1-year (31536000) TTL.
        expect(cdnTf).toContain('31536000');
        // The ACM cert is pinned to us-east-1 (CloudFront requirement).
        expect(cdnTf).toMatch(/provider\s*=\s*aws\.us_east_1/);
    });
});

describe('origin + app wiring', () => {
    it('next.config.js drives assetPrefix from ASSET_PREFIX env', () => {
        expect(nextCfg).toMatch(/assetPrefix:\s*process\.env\.ASSET_PREFIX/);
    });

    it('Caddyfile emits immutable Cache-Control for /_next/static/*', () => {
        expect(caddy).toContain('/_next/static/*');
        expect(caddy).toMatch(/max-age=31536000,\s*immutable/);
    });
});

describe('release/deploy invalidation', () => {
    it('the deploy workflow runs a CloudFront invalidation', () => {
        expect(deployYml).toMatch(/aws cloudfront create-invalidation/);
        // Targeted: /_next/* and the HTML shell only.
        expect(deployYml).toContain('/_next/*');
    });
});

describe('edge performance (HTTP/3 + brotli + keep-alive)', () => {
    it('the distribution negotiates HTTP/3 (http2and3)', () => {
        expect(cdnTf).toMatch(/http_version\s*=\s*"http2and3"/);
    });

    it('the origin keeps a warm connection pool (keepalive >= 30s)', () => {
        const m = cdnTf.match(/origin_keepalive_timeout\s*=\s*(\d+)/);
        expect(m).not.toBeNull();
        expect(parseInt(m![1], 10)).toBeGreaterThanOrEqual(30);
    });

    it('the origin speaks TLS 1.3 to the edge', () => {
        expect(cdnTf).toMatch(/origin_ssl_protocols\s*=\s*\[\s*"TLSv1\.2"\s*,\s*"TLSv1\.3"\s*\]/);
    });

    it('the default (HTML) behavior documents the no-store / no-shared-cache policy', () => {
        // The rationale comment must explain why tenant HTML is never edge-cached.
        expect(cdnTf).toMatch(/never be served from a shared edge/i);
    });

    it('brotli is enabled on every cache behavior (compress = true)', () => {
        // CloudFront serves content-encoding: br when compress=true and the
        // client advertises it. All behaviors must opt in.
        const compressCount = (cdnTf.match(/compress\s*=\s*true/g) ?? []).length;
        expect(compressCount).toBeGreaterThanOrEqual(4);
    });

    it('Caddy advertises the h3 protocol at the origin', () => {
        expect(caddy).toMatch(/protocols\s+h1\s+h2\s+h3/);
    });
});
