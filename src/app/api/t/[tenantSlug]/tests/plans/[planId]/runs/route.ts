/**
 * POST /api/t/[tenantSlug]/tests/plans/[planId]/runs — Create a test run for this plan
 */
import { createTestRun } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; planId: string };

/**
 * Gated on `tests.execute`, the key `createTestRun` already asserts
 * (`assertCanExecuteTests`), so no role gains or loses anything. The gate is
 * what makes a refusal write a hash-chained AUTHZ_DENIED row; the usecase's
 * throw records nothing (#4387). The usecase assert stays.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('tests.execute', async (_req, { params }, ctx) => {
        const run = await createTestRun(ctx, params.planId);
        return jsonResponse(run, { status: 201 });
    }),
);
