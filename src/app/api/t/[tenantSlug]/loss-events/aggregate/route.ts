/**
 * RQ3-6 — loss-event predicted-vs-actual aggregate.
 *
 * The roll-up the dashboard + risk detail panel consume to overlay
 * actuals on the simulator's per-year mean / P90 / portfolio
 * percentiles. Aggregated server-side so the client never holds raw
 * row volume; per-year + per-risk slices are emitted in one pass.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { getLossEventAggregate } from '@/app-layer/usecases/loss-event';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';
import { assertCanRead } from '@/app-layer/policies/common';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const url = new URL(req.url);
        const riskId = url.searchParams.get('riskId') ?? undefined;
        const aggregate = await cachedAggregationRead({
            scopeKey: ctx.tenantId,
            aggregation: 'loss-events-aggregate',
            dependsOn: AGGREGATIONS['loss-events-aggregate'].dependsOn,
            ttlSeconds: AGGREGATIONS['loss-events-aggregate'].ttlSeconds,
            variant: { riskId: riskId ?? null },
            authorize: () => assertCanRead(ctx),
            compute: () => getLossEventAggregate(ctx, { riskId }),
        });
        return jsonResponse(aggregate);
    },
);
