/**
 * GUARD — saving the risk-matrix config invalidates the /risks SSR cache.
 *
 * The `/risks` page SSR-caches its payload (risks + matrixConfig) per tenant
 * for a short TTL via `cachedSsrPayload({ route: 'risks' })`. If
 * `updateRiskMatrixConfig` does NOT bump the tenant SSR cache version after
 * writing, the live risk matrix keeps rendering STALE axis labels / bands
 * until the TTL lapses — the "custom axis title never propagates to /risks"
 * bug that reddened the risk-matrix-admin E2E consistently.
 *
 * This locks the invalidation so a refactor can't silently drop it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('GUARD: risk-matrix config save invalidates the /risks SSR cache', () => {
    const src = read('src/app-layer/usecases/risk-matrix-config.ts');

    it('imports the tenant cache-version invalidator', () => {
        expect(src).toMatch(/import\s*\{\s*bumpEntityCacheVersion\s*\}\s*from\s*'@\/lib\/cache\/list-cache'/);
    });

    it('updateRiskMatrixConfig bumps the cache version after the write', () => {
        const fn = src.slice(src.indexOf('export async function updateRiskMatrixConfig'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        expect(body).toMatch(/bumpEntityCacheVersion\(ctx,/);
        // It must come AFTER the DB write (the runInTenantContext block), not
        // before — otherwise it bumps then re-caches the stale payload.
        expect(body.indexOf('runInTenantContext')).toBeLessThan(
            body.indexOf('bumpEntityCacheVersion'),
        );
    });

    it('the /risks page SSR-caches its payload (documents why invalidation is needed)', () => {
        const page = read('src/app/t/[tenantSlug]/(app)/risks/page.tsx');
        expect(page).toMatch(/cachedSsrPayload/);
        expect(page).toMatch(/route:\s*'risks'/);
    });
});
