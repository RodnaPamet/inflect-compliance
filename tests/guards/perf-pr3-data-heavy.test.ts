/**
 * perf(PR3) — data-heavy page wins. Structural ratchet for the four
 * server/bundle optimisations so a later "simplify" PR can't silently
 * reintroduce the waterfalls / extra round-trips / eager chart bundles.
 *
 * Tracking issue #1112; see docs/implementation-notes/2026-06-19-perf-pr3-data-heavy.md.
 *
 *   1. RLS round-trips — runInTenantContext writes BOTH GUCs in ONE
 *      `SELECT set_config(...), set_config(...)` round-trip (was two).
 *   2. Dashboard waterfall — getStats runs every count in ONE Promise.all
 *      (no trailing sequential `await db.*.count`).
 *   3. Dashboard waterfall — the page fetches exec + matrix + trends in ONE
 *      Promise.all (trends no longer awaited after the batch).
 *   4. Lazy charts — DashboardClient loads the heavy viz via next/dynamic
 *      (ssr:false); dashboard usecase wraps reads in the short-TTL cache.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('perf(PR3) — data-heavy page wins', () => {
    describe('1. RLS set_config round-trip merge', () => {
        const db = read('src/lib/db-context.ts');

        it('runInTenantContext sets both GUCs in ONE round-trip', () => {
            // One SELECT, two comma-separated set_config calls — not two
            // separate `await tx.$executeRaw\`SELECT set_config(...)\`` lines.
            expect(db).toMatch(
                /set_config\('app\.tenant_id',\s*\$\{ctx\.tenantId\},\s*true\),\s*set_config\('app\.request_id',\s*\$\{ctx\.requestId\},\s*true\)/,
            );
        });

        it('does NOT issue app.request_id as its own separate statement', () => {
            // The old waterfall shape — a standalone request_id SELECT.
            expect(db).not.toMatch(
                /\$executeRaw`SELECT set_config\('app\.request_id'/,
            );
        });
    });

    describe('2. Dashboard getStats — single parallel batch', () => {
        const repo = read('src/app-layer/repositories/DashboardRepository.ts');
        const getStats = repo.slice(
            repo.indexOf('static async getStats'),
            repo.indexOf('static async', repo.indexOf('static async getStats') + 10),
        );

        it('runs every headline count INSIDE the single Promise.all batch', () => {
            const batchStart = getStats.indexOf('await Promise.all([');
            const batchEnd = getStats.indexOf(']);', batchStart);
            const batch = getStats.slice(batchStart, batchEnd);
            expect(batch).toMatch(/inherentScore/);          // highRisks
            expect(batch).toMatch(/status: 'SUBMITTED'/);    // pendingEvidence
            expect(batch).toMatch(/nextReviewDate/);         // overdueEvidence
        });

        it('has no trailing sequential `const x = await db.*.count` after the batch', () => {
            // The waterfall regression shape.
            expect(getStats).not.toMatch(/const highRisks = await db\./);
            expect(getStats).not.toMatch(/const pendingEvidence = await db\./);
        });
    });

    describe('3. Dashboard page — trends fetched in parallel', () => {
        const page = read('src/app/t/[tenantSlug]/(app)/dashboard/page.tsx');

        it('fetches exec + trends in ONE Promise.all', () => {
            // The risk-matrix config fetch left the batch when the Risk Matrix
            // widget was removed from the dashboard.
            const batchStart = page.indexOf('await Promise.all([');
            const batchEnd = page.indexOf(']);', batchStart);
            const batch = page.slice(batchStart, batchEnd);
            expect(batch).toMatch(/getExecutiveDashboard\(ctx\)/);
            expect(batch).toMatch(/getComplianceTrends\(ctx,\s*30\)\.catch/);
        });

        it('does NOT await getComplianceTrends after the batch (no waterfall)', () => {
            expect(page).not.toMatch(/trends\s*=\s*await getComplianceTrends/);
        });
    });

    describe('4. Lazy charts + dashboard cache', () => {
        const client = read('src/app/t/[tenantSlug]/(app)/dashboard/DashboardClient.tsx');
        const usecase = read('src/app-layer/usecases/dashboard.ts');
        const cache = read('src/lib/cache/list-cache.ts');

        it('DashboardClient lazy-loads the heavy charts via next/dynamic (ssr:false)', () => {
            expect(client).toMatch(/import dynamic from 'next\/dynamic'/);
            // RiskMatrix + ExpiryCalendar were removed from the dashboard; the
            // remaining heavy charts still lazy-load via next/dynamic.
            for (const chart of ['DonutChart', 'TrendCard']) {
                expect(client).toMatch(
                    new RegExp(`const ${chart} = dynamic\\(`),
                );
            }
            expect(client).toMatch(/ssr:\s*false/);
        });

        it('getExecutiveDashboard is wrapped in the short-TTL dashboard cache', () => {
            expect(usecase).toMatch(/cachedDashboardRead\(/);
            // Authorization stays OUTSIDE the cache (always enforced).
            expect(usecase).toMatch(/assertCanRead\(ctx\);[\s\S]*?cachedDashboardRead/);
        });

        it('the dashboard cache keys by BOTH tenantId and userId', () => {
            expect(cache).toMatch(/export async function cachedDashboardRead/);
            // Key template embeds tenantId then userId.
            expect(cache).toMatch(/:dashboard:\$\{opts\.operation\}:\$\{tenantId\}:\$\{userId\}/);
        });
    });
});
