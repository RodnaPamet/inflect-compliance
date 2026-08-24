import { NextRequest } from 'next/server';
import { restorePolicy } from '@/app-layer/usecases/policy';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Bring a soft-deleted policy back into the library. `restorePolicy`
 * delegates to `restoreEntity`, whose assert is the coarse
 * `assertCanAdmin` — so `admin.manage` alone, matching the purge sibling
 * and NOT the two-key conjunction the bulk routes need. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await restorePolicy(ctx, params.id);
        return jsonResponse(result);
    }),
);
