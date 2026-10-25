/**
 * Produce a closed member campaign's evidence PDF again (#4130).
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/evidence/regenerate
 *     → { accessReviewId, evidenceFileRecordId }
 *
 * The close commits before it renders the PDF, so a storage or rendering
 * failure used to leave a CLOSED campaign with no evidence and no way to get
 * any: a second close is refused. This rebuilds the PDF from the stored
 * decisions with the close's own builder (`regenerateAccessReviewEvidence`),
 * and only for a CLOSED member campaign that has none; it executes nothing.
 * Body is empty.
 *
 * Gated by `access_reviews.close` (OWNER + ADMIN): producing the evidence is
 * the second half of closing, and the usecase keeps its own `assertCanAdmin`.
 * A POST on an action leaf, the `…/close` convention, rather than a POST on
 * `…/evidence`, whose GET every role may call.
 */
import { NextRequest } from 'next/server';
import { regenerateAccessReviewEvidence } from '@/app-layer/usecases/access-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.close',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await regenerateAccessReviewEvidence(ctx, params.reviewId);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
