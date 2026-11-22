import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getControlDashboard } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';
import { assertCanReadControls } from '@/app-layer/policies/control.policies';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const dashboard = await cachedAggregationRead({
        scopeKey: ctx.tenantId,
        aggregation: 'controls-dashboard',
        dependsOn: AGGREGATIONS['controls-dashboard'].dependsOn,
        ttlSeconds: AGGREGATIONS['controls-dashboard'].ttlSeconds,
        authorize: () => assertCanReadControls(ctx),
        compute: () => getControlDashboard(ctx),
    });
    return jsonResponse(dashboard);
});
