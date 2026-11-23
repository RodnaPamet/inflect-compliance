/**
 * Mobile layout — the fixed route set on a phone, against the SHARED seeded
 * tenant. Read-only: it loads pages and opens menus, drawers and the create
 * sheet, and never submits anything.
 *
 * One test per configuration (390 dark and 360 light, both Bulgarian). Each
 * signs in once, loads every route in `SEED_ROUTES`, holds the four
 * zero-tolerance invariants per route with soft assertions (so one red run
 * names every broken route at once), then compares the ratchet. The route
 * set, known defects and baselines live in `mobile-ratchet.ts`; the metrics
 * live in `scripts/mobile-audit/measure.ts`.
 */
import { test, expect } from '@playwright/test';
import { connectDb, dataNames, resolveContext, resolveRoute } from '../../scripts/mobile-audit/resolve';
import { enumerateRoutes, type AppRoute } from '../../scripts/mobile-audit/routes';
import { signInTenantContext } from '../../scripts/mobile-audit/auth';
import { MOBILE_E2E_CONFIGS, SEED_BASELINE, SEED_ROUTES, fixedRouteKey } from './mobile-ratchet';
import { REPO_ROOT, failingRoutes, holdInvariants, holdRatchet, measureRoute, phoneContext } from './mobile-support';
import type { MetricCounts } from '../../scripts/mobile-audit/measure';

/** Fill every fixed route from the seeded database once, before the configurations run. */
async function resolveSeedRoutes(): Promise<{ urls: Map<string, string>; names: Set<string> }> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('the mobile layout spec reads the seeded database: set DATABASE_URL');
    const db = connectDb(databaseUrl);
    try {
        const ctx = await resolveContext(db);
        const routes = new Map<string, AppRoute>(enumerateRoutes(REPO_ROOT).map((r) => [r.pattern, r]));
        const urls = new Map<string, string>();
        for (const fixed of SEED_ROUTES) {
            const route = routes.get(fixed.route);
            if (!route) throw new Error(`${fixed.route} is in SEED_ROUTES but no page.tsx serves it`);
            const r = await resolveRoute(route, ctx);
            if ('uncaptured' in r) throw new Error(`${fixed.route} cannot be filled from the seed: ${r.uncaptured}`);
            urls.set(fixed.route, r.url);
        }
        return { urls, names: await dataNames(db) };
    } finally {
        await db.$disconnect();
    }
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`fixed routes hold on a phone — ${config}`, async ({ browser }, testInfo) => {
        test.setTimeout(10 * 60_000);
        const { urls, names } = await resolveSeedRoutes();
        const signedIn = await phoneContext(browser, config, testInfo);
        const anonymous = await phoneContext(browser, config, testInfo);
        try {
            await signInTenantContext(signedIn);
            const counts: MetricCounts[] = [];
            const perRoute: Record<string, MetricCounts> = {};
            for (const fixed of SEED_ROUTES) {
                const key = fixedRouteKey(fixed);
                await test.step(key, async () => {
                    const ctx = fixed.route.startsWith('/t/') ? signedIn : anonymous;
                    const page = await ctx.newPage();
                    try {
                        const m = await measureRoute(page, urls.get(fixed.route)!, fixed.state, names);
                        holdInvariants(key, config, m.raw);
                        counts.push(m.counts);
                        perRoute[key] = m.counts;
                    } catch (e) {
                        // Soft, so the remaining routes are still measured; the
                        // length check below then fails the run.
                        expect.soft(String(e), `${key} @ ${config} could not be measured`).toBe('');
                    } finally {
                        await page.close();
                    }
                });
            }
            // Per-route counts, so a red ratchet names the route that moved.
            await testInfo.attach('mobile-counts.json', { body: JSON.stringify(perRoute, null, 2), contentType: 'application/json' });
            // Every route captured, or the counts below would be over a smaller population.
            expect(counts).toHaveLength(SEED_ROUTES.length);
            holdRatchet('SEED_ROUTES', config, failingRoutes(counts), SEED_BASELINE[config]);
        } finally {
            await signedIn.close();
            await anonymous.close();
        }
    });
}
