/**
 * POST /api/t/[tenantSlug]/vendor-assessment-reviews/[assessmentId]/revoke
 *
 * Kill the external respondent link in place.
 *
 * Distinct from `resend`, which mints a FRESH token and therefore
 * invalidates whatever link is already circulating — the wrong tool when a
 * link has leaked and the goal is simply to stop it working. Revoke sets
 * `revokedAt`, which `verifyAccessToken` denies on, without touching the
 * token or the assessment's status.
 *
 * Idempotent: revoking an already-revoked link returns the original
 * timestamp rather than erroring.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { revokeAssessmentLink } from '@/app-layer/usecases/vendor-assessment-send';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        {
            params: paramsPromise,
        }: { params: Promise<{ tenantSlug: string; assessmentId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const result = await revokeAssessmentLink(ctx, params.assessmentId);
        return jsonResponse({
            assessmentId: result.assessmentId,
            revokedAt: result.revokedAt.toISOString(),
        });
    },
);
