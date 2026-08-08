/**
 * Epic G-5 — Single-exception detail under the control scope.
 *
 *   GET /api/t/:slug/controls/:controlId/exceptions/:exceptionId
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getControlException } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { notFound } from '@/lib/errors/types';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{
                tenantSlug: string;
                controlId: string;
                exceptionId: string;
            }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const ex = await getControlException(ctx, params.exceptionId);
        // The exception MUST belong to the control in the URL —
        // otherwise the URL is lying about the entity hierarchy.
        if (ex.controlId !== params.controlId) {
            throw notFound('Control exception not found');
        }
        return jsonResponse(ex);
    },
);
