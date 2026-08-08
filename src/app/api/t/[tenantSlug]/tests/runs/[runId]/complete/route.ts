/**
 * POST /api/t/[tenantSlug]/tests/runs/[runId]/complete — Complete a test run with result
 */
import { getTenantCtx } from '@/app-layer/context';
import { completeTestRun } from '@/app-layer/usecases/control';
import { withValidatedBody } from '@/lib/validation/route';
import { CompleteTestRunSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(CompleteTestRunSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const run = await completeTestRun(ctx, params.runId, body);
    return jsonResponse(run);
}));
