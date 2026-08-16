import { NextRequest } from 'next/server';
import { purgeRisk } from '@/app-layer/usecases/risk';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Irreversible hard-delete. `admin.manage` matches the `assertCanAdmin` that
 * `purgeRisk` reaches through `purgeEntity` / `restoreEntity`, so the
 * middleware is the layer that denies — and a middleware denial is the only
 * one that writes an AUTHZ_DENIED audit row. See docs/epic-c-security.md (C.1).
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await purgeRisk(ctx, params.id);
        return jsonResponse(result);
    }),
);
