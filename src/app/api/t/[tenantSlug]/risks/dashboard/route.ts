import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getRiskDashboard } from '@/app-layer/usecases/risk-dashboard';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';
import { assertCanRead } from '@/app-layer/policies/common';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const dashboard = await cachedAggregationRead({
        scopeKey: ctx.tenantId,
        aggregation: 'risks-dashboard',
        dependsOn: AGGREGATIONS['risks-dashboard'].dependsOn,
        ttlSeconds: AGGREGATIONS['risks-dashboard'].ttlSeconds,
        authorize: () => assertCanRead(ctx),
        compute: () => getRiskDashboard(ctx),
    });
    return jsonResponse(dashboard);
});
