/** @deprecated Use /api/t/[tenantSlug]/tasks/[taskId]/links/[linkId] */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { removeTaskLink } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; issueId: string; linkId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await removeTaskLink(ctx, params.issueId, params.linkId);
    return jsonResponse({ success: true });
});
