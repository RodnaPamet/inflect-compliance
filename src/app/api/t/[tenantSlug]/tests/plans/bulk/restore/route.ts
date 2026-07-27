import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { bulkRestoreTestPlan } from '@/app-layer/usecases/control-test';
import { withValidatedBody } from '@/lib/validation/route';
import { BulkTestPlanRestoreSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    withValidatedBody(
        BulkTestPlanRestoreSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await bulkRestoreTestPlan(ctx, body.planIds);
            return jsonResponse(result);
        },
    ),
);
