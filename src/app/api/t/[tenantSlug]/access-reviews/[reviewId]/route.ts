/**
 * Epic G-4 — Access Review detail.
 *
 *   GET   /api/t/:slug/access-reviews/:reviewId
 *     → campaign + every decision row + reviewer/creator/closer +
 *       per-decision subject user + joined live membership.
 *
 *   PATCH /api/t/:slug/access-reviews/:reviewId          (#4130)
 *     Body: { reviewerUserId?: string, dueAt?: ISO string | null }
 *     → { accessReviewId, reviewerUserId, dueAt, changed }
 *     Changes the reviewer and/or the due date of an OPEN or IN_REVIEW
 *     campaign, and nothing else — the body schema is strict, so a name,
 *     scope or period in it is a 400. There is no DELETE.
 *
 * Step 5a: gated by `access_reviews.view` at the route so a refused read
 * writes `AUTHZ_DENIED`; `getAccessReviewWithActivity` keeps its own
 * `assertCanRead` for non-HTTP callers. Same caller set as before.
 *
 * The PATCH takes `access_reviews.create` — the key that names a campaign's
 * reviewer and due date in the first place (OWNER + ADMIN), mirroring the
 * `assertCanAdmin` in `updateAccessReviewSettings`. The body is read with
 * `parseJsonBody` inside the handler, after authorisation, for the reason the
 * list route gives.
 */
import { NextRequest } from 'next/server';
import {
    getAccessReviewWithActivity,
    updateAccessReviewSettings,
} from '@/app-layer/usecases/access-review';
import { UpdateAccessReviewSettingsSchema } from '@/app-layer/schemas/access-review.schemas';
import { parseJsonBody } from '@/lib/validation/route';
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

export const PATCH = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.create',
        async (req: NextRequest, { params }, ctx) => {
            const body = await parseJsonBody(req, UpdateAccessReviewSettingsSchema);
            const result = await updateAccessReviewSettings(ctx, params.reviewId, body);
            return jsonResponse(result);
        },
    ),
);
