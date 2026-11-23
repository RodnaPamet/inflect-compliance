/**
 * Mobile layout — the P0 pages whose records the seed does not have (a test
 * plan, a business impact analysis). Each test provisions an isolated tenant,
 * creates the records through the product's own API, and holds the same
 * invariants and ratchet as `mobile-layout.spec.ts` over `RECORD_ROUTES`.
 */
import { test, expect } from './fixtures';
import { PHONE_CONFIGS, preferenceCookies } from '../../scripts/mobile-audit/configs';
import { fillPattern } from '../../scripts/mobile-audit/routes';
import type { MetricCounts } from '../../scripts/mobile-audit/measure';
import { MOBILE_E2E_CONFIGS, RECORDS_BASELINE, RECORD_ROUTES, fixedRouteKey } from './mobile-ratchet';
import { failingRoutes, holdInvariants, holdRatchet, measureRoute } from './mobile-support';

async function created(res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }, what: string): Promise<string> {
    if (!res.ok()) throw new Error(`creating ${what} failed: ${res.status()} ${await res.text()}`);
    return ((await res.json()) as { id: string }).id;
}

for (const config of MOBILE_E2E_CONFIGS) {
    test(`P0 record pages hold on a phone — ${config}`, async ({ authedPage: page, isolatedTenant }, testInfo) => {
        test.setTimeout(5 * 60_000);
        const slug = isolatedTenant.tenantSlug;
        const api = (p: string) => `/api/t/${slug}${p}`;
        const json = { 'Content-Type': 'application/json' };

        // A long name on purpose: a phone header must wrap it, not clip it.
        const controlId = await created(await page.request.post(api('/controls'), {
            headers: json,
            data: { name: 'Access review of privileged production accounts', code: 'MOB-1', status: 'NOT_STARTED', isCustom: true },
        }), 'a control');
        const planId = await created(await page.request.post(api(`/controls/${controlId}/tests/plans`), {
            headers: json,
            data: {
                name: 'Quarterly review of privileged access to the production environment',
                frequency: 'QUARTERLY',
                steps: [{ instruction: 'Export the list of privileged accounts', expectedOutput: 'A CSV of accounts' }],
            },
        }), 'a test plan');
        const biaId = await created(await page.request.post(api('/business-continuity'), {
            headers: json,
            data: { name: 'Customer payments processing', criticality: 'HIGH', rtoHours: 4, rpoHours: 1, mtpdHours: 24, notes: 'Card payments and refunds.' },
        }), 'a business impact analysis');

        const baseURL = testInfo.project.use.baseURL!;
        const phone = PHONE_CONFIGS[config];
        await page.setViewportSize({ width: phone.width, height: phone.height });
        await page.context().addCookies(preferenceCookies(phone, baseURL));

        const values = { tenantSlug: slug, controlId, planId, id: biaId };
        const counts: MetricCounts[] = [];
        const perRoute: Record<string, MetricCounts> = {};
        for (const fixed of RECORD_ROUTES) {
            const key = fixedRouteKey(fixed);
            await test.step(key, async () => {
                const url = fillPattern(fixed.route, values);
                expect(url, `${fixed.route}: no value for one of its segments`).not.toBeNull();
                const m = await measureRoute(page, url!, fixed.state, new Set([isolatedTenant.tenantName]));
                holdInvariants(key, config, m.raw);
                counts.push(m.counts);
                perRoute[key] = m.counts;
            });
        }
        await testInfo.attach('mobile-counts.json', { body: JSON.stringify(perRoute, null, 2), contentType: 'application/json' });
        expect(counts).toHaveLength(RECORD_ROUTES.length);
        holdRatchet('RECORD_ROUTES', config, failingRoutes(counts), RECORDS_BASELINE[config]);
    });
}
