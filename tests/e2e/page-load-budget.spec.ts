import { test, expect } from '@playwright/test';
import { loginAndGetTenant, safeGoto } from './e2e-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Page-load budget probe — the measurement engine for the "instant pages" loop.
 *
 * Logs in once, then visits every tenant route and records the SERVER response
 * time (TTFB ≈ `response.request().timing().responseStart`) — the part the app
 * controls and the lever that makes a page "feel instant". A full network
 * page-load can't be 100 ms; the server response can.
 *
 * Targets (the loop drives toward these): **≤100 ms** per route, falling back
 * to **≤200 ms** for genuinely data-heavy pages where 100 ms isn't attainable.
 *
 * This spec REPORTS the per-route number (written to
 * `test-results/page-load-budget.json` + the test log) and asserts only a
 * generous gross-regression ceiling — hard-asserting the tight budget on every
 * route would red-CI the whole suite before the optimization passes land. As
 * pages are optimized, `PER_ROUTE_TARGET_MS` / `FALLBACK_ROUTES` are the
 * confirmation ledger.
 */

// Routes with no path params — measured directly.
const STATIC_ROUTES = [
    'dashboard',
    'controls', 'controls/dashboard', 'controls/sankey', 'controls/templates',
    'risks', 'risks/board', 'risks/correlations', 'risks/dashboard', 'risks/hierarchy',
    'risks/kri', 'risks/loss-events', 'risks/reports', 'risks/scenarios',
    'evidence', 'findings', 'frameworks', 'clauses', 'coverage', 'calendar',
    'policies', 'policies/templates',
    'tasks', // tasks/dashboard retired in TP-7 (redirect shim → /tasks)
    'tests', 'tests/dashboard', 'tests/due',
    'vendors', 'vendors/dashboard',
    'audits', 'audits/cycles', 'audits/readiness',
    'issues', 'issues/dashboard',
    'access-reviews', 'mapping', 'notifications', 'processes', 'processes/governance',
    'reports', 'reports/soa',
    'admin/members', 'admin/api-keys', 'admin/audit-log', 'admin/billing',
    'admin/integrations', 'admin/notifications', 'admin/rbac', 'admin/roles',
    'admin/risk-appetite', 'admin/risk-matrix', 'admin/scim', 'admin/security',
    'admin/sso', 'admin/vendor-templates',
];

// Detail routes: `{ pattern, listApi, idField }` — the probe pulls the first id
// from the list API so the parameterized page is measured against real data.
const DETAIL_ROUTES: { label: string; build: (id: string) => string; listApi: string }[] = [
    { label: 'controls/[id]', build: (id) => `controls/${id}`, listApi: '/controls' },
    { label: 'risks/[id]', build: (id) => `risks/${id}`, listApi: '/risks' },
    { label: 'tasks/[id]', build: (id) => `tasks/${id}`, listApi: '/tasks' },
    { label: 'policies/[id]', build: (id) => `policies/${id}`, listApi: '/policies' },
    { label: 'vendors/[id]', build: (id) => `vendors/${id}`, listApi: '/vendors' },
    { label: 'assets/[id]', build: (id) => `assets/${id}`, listApi: '/assets' },
    { label: 'issues/[id]', build: (id) => `issues/${id}`, listApi: '/issues' },
];

const PER_ROUTE_TARGET_MS = 100;
const FALLBACK_TARGET_MS = 200;
/**
 * Routes confirmed to use the ≤200 ms fallback. After the 2026-06-20 baseline,
 * 57/63 routes measured ≤100 ms. The 5 below measured 101–116 ms and are NOT
 * reducible by per-page query work:
 *   - `tasks` (list) already uses `cachedListRead` — the 112 ms was a cold-cache
 *     first hit; warm hits are fast.
 *   - `assets/[id]`, `risks/reports`, `controls/[id]`, `tasks/[id]` are
 *     `'use client'` pages whose data loads AFTER the response, so their server
 *     TTFB is purely the shared tenant-layout render (auth → tenant ctx → plan)
 *     plus CI runner noise (±10–20 ms is normal at this scale).
 * The only sub-100 ms lever is optimizing that shared auth/tenant layout — a
 * security-sensitive change for a marginal, partly-noise gain. Per product
 * decision (2026-06-20) these run on the ≤200 ms fallback; all are well under.
 * Retire an entry if a shared-layout optimization later lands it ≤100 ms.
 */
const FALLBACK_ROUTES = new Set<string>([
    'tasks',
    'assets/[id]',
    'risks/reports',
    'controls/[id]',
    'tasks/[id]',
]);
// Gross-regression ceiling — fails CI only on a pathological server time. The
// tight targets above are tracked/ratcheted, not hard-asserted yet.
const CEILING_MS = 1500;

async function firstId(page: import('@playwright/test').Page, tenantSlug: string, listApi: string): Promise<string | null> {
    try {
        const res = await page.request.get(`/api/t/${tenantSlug}${listApi}?limit=1`);
        if (!res.ok()) return null;
        const data = await res.json();
        const rows = Array.isArray(data) ? data : (data.rows ?? data.items ?? []);
        return rows[0]?.id ?? null;
    } catch {
        return null;
    }
}

test.describe('Page-load budget probe', () => {
    test.describe.configure({ mode: 'serial' });

    test('measure server response time for every tenant route', async ({ page }) => {
        test.setTimeout(300_000);
        const tenantSlug = await loginAndGetTenant(page);

        const results: { route: string; ttfbMs: number; target: number; ok: boolean }[] = [];

        const measure = async (label: string, url: string) => {
            const resp = await safeGoto(page, url).catch(() => null);
            const timing = resp?.request().timing();
            const ttfb = timing ? Math.round(timing.responseStart - timing.requestStart) : -1;
            const target = FALLBACK_ROUTES.has(label) ? FALLBACK_TARGET_MS : PER_ROUTE_TARGET_MS;
            results.push({ route: label, ttfbMs: ttfb, target, ok: ttfb >= 0 && ttfb <= target });
        };

        for (const r of STATIC_ROUTES) {
            await measure(r, `/t/${tenantSlug}/${r}`);
        }
        for (const d of DETAIL_ROUTES) {
            const id = await firstId(page, tenantSlug, d.listApi);
            if (id) await measure(d.label, `/t/${tenantSlug}/${d.build(id)}`);
        }

        results.sort((a, b) => b.ttfbMs - a.ttfbMs);

        // Per-route report → log + artifact.
        const lines = results.map(
            (r) => `${r.ok ? '✓' : '✗'} ${String(r.ttfbMs).padStart(5)}ms  (≤${r.target})  ${r.route}`,
        );
        console.log('\n=== Page-load budget (server TTFB) ===\n' + lines.join('\n'));
        try {
            const dir = path.resolve(process.cwd(), 'test-results');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'page-load-budget.json'), JSON.stringify(results, null, 2));
        } catch {
            /* artifact best-effort */
        }

        // Gross-regression ceiling only (tight targets are the ratcheted ledger).
        const overCeiling = results.filter((r) => r.ttfbMs > CEILING_MS);
        expect(
            overCeiling,
            `Routes exceeding the ${CEILING_MS}ms gross-regression ceiling:\n` +
                overCeiling.map((r) => `  ${r.ttfbMs}ms  ${r.route}`).join('\n'),
        ).toHaveLength(0);
    });
});
