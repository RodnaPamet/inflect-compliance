import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getVendorMetrics } from '@/app-layer/usecases/vendor';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';
import { assertCanReadVendors } from '@/app-layer/policies/vendor.policies';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const metrics = await cachedAggregationRead({
        scopeKey: ctx.tenantId,
        aggregation: 'vendors-metrics',
        dependsOn: AGGREGATIONS['vendors-metrics'].dependsOn,
        ttlSeconds: AGGREGATIONS['vendors-metrics'].ttlSeconds,
        authorize: () => assertCanReadVendors(ctx),
        compute: () => getVendorMetrics(ctx),
    });
    return jsonResponse(metrics);
});
