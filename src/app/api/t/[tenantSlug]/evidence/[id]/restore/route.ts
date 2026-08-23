import { NextRequest } from 'next/server';
import { restoreEvidence } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Bring a soft-deleted evidence record back into the register.
 * `admin.manage` matches the `assertCanAdmin` that `restoreEvidence`
 * reaches through `restoreEntity` — the same key its purge sibling
 * declares, because both verbs sit behind the same assert. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await restoreEvidence(ctx, params.id);
        return jsonResponse(result);
    }),
);
