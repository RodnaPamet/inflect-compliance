import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { submitAssignmentAnswers } from '@/app-layer/usecases/gap-assessment-assignment';
import { SubmitAssignmentSchema } from '@/app-layer/schemas/gap-assessment-assignment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST — save (`final: false`) or submit the caller's bucket answers.
 * Out-of-bucket ids, and a submit with questions unanswered, are refused in
 * the usecase.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; assignmentId: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = SubmitAssignmentSchema.parse(await req.json().catch(() => ({})));
    return jsonResponse(
        await submitAssignmentAnswers(ctx, params.assignmentId, body.answers, { final: body.final }),
    );
});
