import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getAppetiteConfig,
    upsertAppetiteConfig,
    getAppetiteStatus,
    getAppetiteApproval,
} from '@/app-layer/usecases/risk-appetite';
import { RiskAppetiteConfigSchema } from '@/app-layer/schemas/risk-appetite.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/** RQ-2 — risk appetite config + live status, and who approved it. */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const [config, status] = await Promise.all([getAppetiteConfig(ctx), getAppetiteStatus(ctx)]);
        const approval = await getAppetiteApproval(ctx, config);
        return jsonResponse({ config, status, approval });
    },
);

/**
 * Saves the statement and limits. It never approves them: the body schema is
 * strict and carries no approval field (#5313 item 11); the approval is
 * `POST …/risk-appetite/approve`, and a save that changes the statement or a
 * limit clears it.
 */
export const PUT = withApiErrorHandling(
    withValidatedBody(RiskAppetiteConfigSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const config = await upsertAppetiteConfig(ctx, body);
        return jsonResponse({ success: true, config });
    }),
);
