/**
 * SSR-cache coverage ratchet.
 *
 * The SSR payload cache (src/lib/cache/ssr-cache.ts) caches the expensive
 * server-component data fetch per (tenant, route), invalidated by a
 * tenant-wide version bump. This guard locks the wiring so a refactor
 * can't silently drop the cache or — worse — the tenant-version bump that
 * invalidates it (which would serve stale tenant data past the TTL).
 *
 * See docs/response-caching.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));

const APP = 'src/app/t/[tenantSlug]/(app)';
const DASHBOARD = `${APP}/dashboard/page.tsx`;
const LIST_PAGES = ['risks', 'controls', 'assets', 'policies', 'tasks'].map(
    (e) => `${APP}/${e}/page.tsx`,
);

describe('SSR cache coverage', () => {
    it('the SSR cache module exists', () => {
        expect(exists('src/lib/cache/ssr-cache.ts')).toBe(true);
        expect(read('src/lib/cache/ssr-cache.ts')).toMatch(/export async function cachedSsrPayload/);
    });

    it('the dashboard server component uses cachedSsrPayload', () => {
        const src = read(DASHBOARD);
        expect(src).toMatch(/cachedSsrPayload\s*\(/);
        expect(src).toContain("route: 'dashboard'");
    });

    describe('the 5 main list pages use cachedSsrPayload', () => {
        for (const page of LIST_PAGES) {
            it(page, () => {
                expect(exists(page)).toBe(true);
                expect(read(page)).toMatch(/cachedSsrPayload\s*\(/);
            });
        }
    });

    it('bumpEntityCacheVersion also bumps the tenant-wide version', () => {
        const src = read('src/lib/cache/list-cache.ts');
        // The tenant-wide key + its bump must exist…
        expect(src).toMatch(/export function tenantVersionKey/);
        expect(src).toMatch(/export async function bumpTenantCacheVersion/);
        // …and bumpEntityCacheVersion must call it (so every entity write
        // invalidates the tenant's SSR payloads).
        const fn = src.slice(src.indexOf('export async function bumpEntityCacheVersion'));
        expect(fn.slice(0, 600)).toMatch(/bumpTenantCacheVersion\(/);
    });

    it('SSR TTLs are bounded (helper cap ≤ 300s; no call site exceeds it)', () => {
        const ssr = read('src/lib/cache/ssr-cache.ts');
        const cap = ssr.match(/MAX_SSR_TTL_SECONDS\s*=\s*(\d+)/);
        expect(cap).not.toBeNull();
        expect(parseInt(cap![1], 10)).toBeLessThanOrEqual(300);

        // No wired page passes a literal ttlSeconds above the cap.
        for (const page of [DASHBOARD, ...LIST_PAGES]) {
            const src = read(page);
            for (const m of src.matchAll(/ttlSeconds:\s*(\d+)/g)) {
                expect(parseInt(m[1], 10)).toBeLessThanOrEqual(300);
            }
        }
    });
});
