/**
 * GET /api/t/[tenantSlug]/tests/dashboard?period=30|90|180|365
 *
 * Returns the legacy frequency/`nextDueAt`-keyed metrics merged with
 * the new Epic G-2 automation/schedule slice. Both halves run in
 * parallel — the legacy metrics still drive existing UI consumers,
 * the G-2 slice (`automation`, `upcoming`, `trend`) drives the
 * Epic G-2 widgets built in the next prompt.
 *
 * Response shape (additive, no breaking changes):
 *
 *   {
 *     // ── existing fields (unchanged) ──
 *     periodDays, periodStart, totalPlans, totalRuns, completedRuns,
 *     passRuns, failRuns, inconclusiveRuns, completionRate, passRate,
 *     failRate, evidenceRate, overduePlans, repeatedFailures,
 *
 *     // ── new Epic G-2 fields ──
 *     automation: { plansManual, plansScript, plansIntegration,
 *                   plansScheduledActive, overdueScheduled },
 *     upcoming:   UpcomingTestDto[],   // top-10
 *     trend:      { days[], pass[], fail[], inconclusive[] },
 *   }
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getTestDashboardMetrics } from '@/app-layer/usecases/due-planning';
import { getTestDashboard } from '@/app-layer/usecases/test-scheduling';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';
import { assertCanReadTests } from '@/app-layer/policies/test.policies';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const url = new URL(req.url);
        const period = parseInt(url.searchParams.get('period') || '30', 10);
        const validPeriod = [30, 90, 180, 365].includes(period) ? period : 30;

        const dashboard = await cachedAggregationRead({
            scopeKey: ctx.tenantId,
            aggregation: 'tests-dashboard',
            dependsOn: AGGREGATIONS['tests-dashboard'].dependsOn,
            ttlSeconds: AGGREGATIONS['tests-dashboard'].ttlSeconds,
            variant: { period: validPeriod },
            authorize: () => assertCanReadTests(ctx),
            compute: async () => {
                const [legacy, g2] = await Promise.all([
                    getTestDashboardMetrics(ctx, validPeriod),
                    getTestDashboard(ctx, validPeriod),
                ]);
                return {
                    ...legacy,
                    automation: g2.automation,
                    upcoming: g2.upcoming,
                    trend: g2.trend,
                };
            },
        });

        return jsonResponse(dashboard);
    },
);
