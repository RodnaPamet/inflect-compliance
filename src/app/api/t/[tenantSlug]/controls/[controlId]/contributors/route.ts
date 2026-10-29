import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listContributors, addContributor } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { AddContributorSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const contributors = await listContributors(ctx, params.controlId);
    return jsonResponse(contributors);
});

/**
 * `addContributor` asserts `assertCanUpdateControl` (`canWrite` +
 * `controls.edit`) and this route carried no gate, so the refusal happened
 * inside the usecase and wrote no `AUTHZ_DENIED` row. The key is the one the
 * usecase already asks for, so no role gains or loses anything (#4387).
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>(
        'controls.edit',
        async (req, { params }, ctx) => {
            const body = await parseJsonBody(req, AddContributorSchema);
            const contributor = await addContributor(ctx, params.controlId, body.userId);
            return jsonResponse(contributor, { status: 201 });
        },
    ),
);
