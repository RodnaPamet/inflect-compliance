/**
 * Epic G-4 — Close a campaign.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/close
 *
 * Executes REVOKE/MODIFY decisions against live `TenantMembership`,
 * emits per-row audit entries, and produces the signed PDF artifact.
 * Body is empty — every input is the campaign id from the URL.
 *
 * Step 5a: gated by `access_reviews.close` (OWNER + ADMIN, mirroring the
 * `assertCanAdmin` both close usecases keep). The scope read that chooses
 * between the two flows now happens AFTER authorisation, so an unauthorised
 * caller can no longer learn whether a campaign exists or what scope it has.
 */
import { NextRequest } from 'next/server';
import {
    closeAccessReview,
    getAccessReview,
} from '@/app-layer/usecases/access-review';
import { closeConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.close',
        async (_req: NextRequest, { params }, ctx) => {
            // PR-7 — CONNECTED_APP campaigns close via the parallel connected flow
            // (remediation tasks); the mature member flow is untouched.
            const review = await getAccessReview(ctx, params.reviewId);
            const result = review?.scope === 'CONNECTED_APP'
                ? await closeConnectedAccessReview(ctx, params.reviewId)
                : await closeAccessReview(ctx, params.reviewId);
            return jsonResponse(result);
        },
    ),
);
