import { NextRequest } from 'next/server';
import { getTaskMetrics } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';

/**
 * GET — tenant task KPI aggregate.
 *
 * Read-gated on `tasks.view` at the route, which matters because the
 * aggregate is served from `cachedAggregationRead`: a gate that lived only
 * inside the compute closure would be skipped entirely on a cache hit.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'tasks.view',
        async (_req: NextRequest, _routeArgs, ctx) => {
            const metrics = await cachedAggregationRead({
                scopeKey: ctx.tenantId,
                aggregation: 'tasks-metrics',
                dependsOn: AGGREGATIONS['tasks-metrics'].dependsOn,
                ttlSeconds: AGGREGATIONS['tasks-metrics'].ttlSeconds,
                compute: () => getTaskMetrics(ctx),
            });
            return jsonResponse(metrics);
        },
    ),
);
