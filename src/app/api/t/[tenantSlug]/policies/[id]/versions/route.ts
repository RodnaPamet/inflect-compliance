import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { getTenantCtx } from '@/app-layer/context';
import { CreatePolicyVersionSchema } from '@/lib/schemas';
import * as policyUsecases from '@/app-layer/usecases/policy';
import { jsonResponse } from '@/lib/api-response';

// POST /api/t/[tenantSlug]/policies/[id]/versions — create new version
export const POST = withApiErrorHandling(
    withValidatedBody(CreatePolicyVersionSchema, async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const { proposeOnly, ...versionData } = body;
        const version = await policyUsecases.createPolicyVersion(ctx, params.id, versionData, {
            proposeOnly: proposeOnly === true,
        });
        return jsonResponse(version, { status: 201 });
    })
);
