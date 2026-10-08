/**
 * Epic G-4 — Access Review detail.
 *
 *   GET /api/t/:slug/access-reviews/:reviewId
 *     → campaign + every decision row + reviewer/creator/closer +
 *       per-decision subject user + joined live membership.
 *
 * Step 5a: gated by `access_reviews.view` at the route so a refused read
 * writes `AUTHZ_DENIED`; `getAccessReviewWithActivity` keeps its own
 * `assertCanRead` for non-HTTP callers. Same caller set as before.
 */
import { NextRequest } from 'next/server';
import { getAccessReviewWithActivity } from '@/app-layer/usecases/access-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.view',
        async (_req: NextRequest, { params }, ctx) => {
            const review = await getAccessReviewWithActivity(ctx, params.reviewId);
            return jsonResponse(review);
        },
    ),
);
