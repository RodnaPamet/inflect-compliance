/**
 * GET  /api/t/[tenantSlug]/tests/due       — Due queue (overdue + due-soon plans)
 * POST /api/t/[tenantSlug]/tests/due       — Trigger due planning (test-plan managers: EDITOR+/tests.create)
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getDueQueue, runDuePlanning } from '@/app-layer/usecases/due-planning';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const queue = await getDueQueue(ctx);
    return jsonResponse(queue);
});

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await runDuePlanning(ctx);
    return jsonResponse(result);
});
