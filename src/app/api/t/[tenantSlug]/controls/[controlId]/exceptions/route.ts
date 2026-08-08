/**
 * Epic G-5 — Control exceptions list + create scoped to one control.
 *
 *   GET  /api/t/:slug/controls/:controlId/exceptions
 *     → array of summary rows for this control
 *   POST /api/t/:slug/controls/:controlId/exceptions
 *     → { exceptionId } — body validated by RequestExceptionSchema.
 *
 * The route nests under the control so the URL tells the same story
 * the UI does: exceptions live in the control-detail context.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    listControlExceptions,
    requestException,
} from '@/app-layer/usecases/control';
import { RequestExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const rows = await listControlExceptions(ctx, {
            controlId: params.controlId,
        });
        return jsonResponse({ rows });
    },
);

export const POST = withApiErrorHandling(
    withValidatedBody(
        RequestExceptionSchema,
        async (
            req: NextRequest,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            // The body's controlId MUST match the path's controlId —
            // a mismatched body is a 400, not a silent override.
            if (body.controlId !== params.controlId) {
                return jsonResponse(
                    {
                        error:
                            'Body controlId must match the URL controlId.',
                    },
                    { status: 400 },
                );
            }
            const result = await requestException(ctx, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
