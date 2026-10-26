import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listContributors, addContributor } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { AddContributorSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const contributors = await listContributors(ctx, params.controlId);
    return jsonResponse(contributors);
});

/**
 * Gated on `controls.edit`, the key `addContributor` already asserts
 * (`assertCanUpdateControl`: the coarse write tier AND `controls.edit`) and the
 * key of the remove route beside it (`[userId]/route.ts`), so no role gains or
 * loses anything. The gate is what makes a refusal write a hash-chained
 * AUTHZ_DENIED row; the usecase's throw records nothing (#4387). The usecase
 * assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, AddContributorSchema);
        const contributor = await addContributor(ctx, params.controlId, body.userId);
        return jsonResponse(contributor, { status: 201 });
    }),
);
