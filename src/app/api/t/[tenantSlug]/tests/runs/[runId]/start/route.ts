/**
 * POST /api/t/[tenantSlug]/tests/runs/[runId]/start — begin a guided test run
 * (PLANNED → RUNNING). R3-P2.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { startTestRun } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const run = await startTestRun(ctx, params.runId);
    return jsonResponse(run);
});
