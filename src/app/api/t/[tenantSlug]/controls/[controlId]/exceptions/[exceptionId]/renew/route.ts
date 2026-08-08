/**
 * Epic G-5 — Renew an exception.
 *
 *   POST /api/t/:slug/controls/:controlId/exceptions/:exceptionId/renew
 *   Body: optional { justification?, compensatingControlId?,
 *                    riskAcceptedByUserId?, expiresAt? }
 *   → creates a NEW exception linked to the supplied id; prior is
 *     untouched.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { renewException } from '@/app-layer/usecases/control';
import { RenewExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    withValidatedBody(
        RenewExceptionSchema,
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
            const result = await renewException(ctx, params.exceptionId, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
