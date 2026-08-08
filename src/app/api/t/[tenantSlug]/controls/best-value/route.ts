import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getBestValueControls } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const limitParam = Number(url.searchParams.get('limit') ?? '10');
    const limit = Number.isFinite(limitParam) ? limitParam : 10;
    return jsonResponse(await getBestValueControls(ctx, limit));
});
