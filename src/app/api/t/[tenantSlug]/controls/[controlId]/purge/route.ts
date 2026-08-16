import { NextRequest } from 'next/server';
import { purgeControl } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * Irreversible hard-delete. `admin.manage` matches the `assertCanAdmin` that
 * `purgeControl` reaches through `purgeEntity` / `restoreEntity`, so the
 * middleware is the layer that denies — and a middleware denial is the only
 * one that writes an AUTHZ_DENIED audit row. See docs/epic-c-security.md (C.1).
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (_req: NextRequest, { params }, ctx) => {
        const result = await purgeControl(ctx, params.controlId);
        return jsonResponse(result);
    }),
);
