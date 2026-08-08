/**
 * GET  /api/t/[tenantSlug]/controls/[controlId]/tests/plans — List test plans for a control
 * POST /api/t/[tenantSlug]/controls/[controlId]/tests/plans — Create a test plan
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listControlTestPlans, createTestPlan } from '@/app-layer/usecases/control';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateTestPlanSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const plans = await listControlTestPlans(ctx, params.controlId);
    return jsonResponse(plans);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateTestPlanSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const plan = await createTestPlan(ctx, params.controlId, body);
    return jsonResponse(plan, { status: 201 });
}));
