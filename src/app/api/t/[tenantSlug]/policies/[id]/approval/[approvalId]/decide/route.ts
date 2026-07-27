import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { getTenantCtx } from '@/app-layer/context';
import { DecideApprovalSchema } from '@/lib/schemas';
import * as policyUsecases from '@/app-layer/usecases/policy';
import { jsonResponse } from '@/lib/api-response';

// POST /api/t/[tenantSlug]/policies/[id]/approval/[approvalId]/decide — approve or reject
export const POST = withApiErrorHandling(
    withValidatedBody(DecideApprovalSchema, async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string; approvalId: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const result = await policyUsecases.decidePolicyApproval(ctx, params.id, params.approvalId, body);
        return jsonResponse(result);
    })
);
