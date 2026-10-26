/**
 * GET  /api/t/[tenantSlug]/controls/[controlId]/tests/plans — List test plans for a control
 * POST /api/t/[tenantSlug]/controls/[controlId]/tests/plans — Create a test plan
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listControlTestPlans, createTestPlan } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateTestPlanSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const plans = await listControlTestPlans(ctx, params.controlId);
    return jsonResponse(plans);
});

/**
 * Gated on `tests.create`, the key `createTestPlan` already asserts
 * (`assertCanManageTestPlans`), so no role gains or loses anything. The gate
 * is what makes a refusal write a hash-chained AUTHZ_DENIED row; the usecase's
 * throw records nothing (#4387). The usecase assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('tests.create', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, CreateTestPlanSchema);
        const plan = await createTestPlan(ctx, params.controlId, body);
        return jsonResponse(plan, { status: 201 });
    }),
);
