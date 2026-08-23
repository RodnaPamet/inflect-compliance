import { NextRequest } from 'next/server';
import { purgePolicy } from '@/app-layer/usecases/policy';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * IRREVERSIBLE hard delete of a soft-deleted policy.
 *
 * `admin.manage` ALONE, unlike the `bulk/delete` sibling: `purgePolicy`
 * delegates straight to `purgeEntity`, which asserts only the coarse
 * `assertCanAdmin` — it never reaches `assertCanAdminPolicies`. Adding
 * `policies.edit` here would make the route STRICTER than the usecase and
 * lock out a custom role the usecase would admit. The key mirrors the
 * assert that actually runs. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await purgePolicy(ctx, params.id);
        return jsonResponse(result);
    }),
);
