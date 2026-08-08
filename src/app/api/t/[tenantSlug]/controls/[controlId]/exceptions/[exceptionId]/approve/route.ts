/**
 * Epic G-5 — Approve a REQUESTED exception.
 *
 *   POST /api/t/:slug/controls/:controlId/exceptions/:exceptionId/approve
 *   Body: { expiresAt: ISO string, note?: string }
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { approveException } from '@/app-layer/usecases/control';
import { ApproveExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    withValidatedBody(
        ApproveExceptionSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{
                    tenantSlug: string;
                    controlId: string;
                    exceptionId: string;
                }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = await approveException(
                ctx,
                params.exceptionId,
                body,
            );
            return jsonResponse(result);
        },
    ),
);
