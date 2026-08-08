/**
 * POST /api/t/[tenantSlug]/tests/plans/[planId]/runs — Create a test run for this plan
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { createTestRun } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; planId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const run = await createTestRun(ctx, params.planId);
    return jsonResponse(run, { status: 201 });
});
