import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getProcessMapRiskFacts } from '@/app-layer/usecases/process-map-risk-asset-facts';
import { MAX_CONTROL_FACT_IDS } from '@/lib/processes/control-facts-types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

const IdsSchema = z
    .array(z.string().min(1).max(64))
    .max(MAX_CONTROL_FACT_IDS);

/**
 * Live facts for the risk nodes on a process map, read by the ids on the
 * canvas (`?ids=a,b,c`). Read-only; a caller who may read the map but not
 * risks gets `restricted: true` and no facts. See
 * `usecases/process-map-risk-asset-facts.ts`.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const raw = req.nextUrl.searchParams.get('ids') ?? '';
        const parsed = IdsSchema.safeParse(raw === '' ? [] : raw.split(','));
        if (!parsed.success) throw badRequest('Invalid ids');
        return jsonResponse(await getProcessMapRiskFacts(ctx, params.id, parsed.data));
    },
);
