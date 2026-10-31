import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getScenarioComparison } from '@/app-layer/usecases/risk-scenario';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * #4770 — a scenario's baseline-vs-scenario comparison, read without running
 * the scenario again. Writes nothing; `getScenarioComparison` asserts read.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; scenarioId: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse({ comparison: await getScenarioComparison(ctx, params.scenarioId) });
    },
);
