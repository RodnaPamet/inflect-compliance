import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { listSubflowGroups } from '@/app-layer/usecases/process-map';

type Ctx = { params: Promise<{ tenantSlug: string }> };

/**
 * #5477 — the tenant's sub-flow groups (group nodes on live AUTOMATION maps),
 * for the rule builder's INVOKE_SUBFLOW target picker. Read-only; the usecase
 * asserts the same read the canvas takes (`assertCanRead`).
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const groups = await listSubflowGroups(ctx);
    return jsonResponse({ groups });
});
