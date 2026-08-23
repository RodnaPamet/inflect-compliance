import { NextRequest } from 'next/server';
import { purgeEvidence } from '@/app-layer/usecases/evidence';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * IRREVERSIBLE hard delete of a soft-deleted evidence record (and its
 * FileRecord chain). `admin.manage` matches the `assertCanAdmin` that
 * `purgeEvidence` reaches through `purgeEntity`. The usecase assert stays;
 * the route gate exists because a middleware denial is the only one that
 * writes an AUTHZ_DENIED audit row. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await purgeEvidence(ctx, params.id);
        return jsonResponse(result);
    }),
);
