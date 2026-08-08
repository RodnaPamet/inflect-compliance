import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkAssignTestPlan } from '@/app-layer/usecases/control';
import { withValidatedBody } from '@/lib/validation/route';
import { BulkTestPlanAssignSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkTestPlanAssignSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkAssignTestPlan(ctx, body.planIds, body.ownerUserId);
            return jsonResponse(result);
        },
    ),
);
