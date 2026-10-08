/**
 * PR-7 — list connected-account decisions for a CONNECTED_APP review.
 *
 * Step 5a: gated by `access_reviews.view`, mirroring the `assertCanRead`
 * `listConnectedDecisions` keeps for non-HTTP callers.
 */
import { NextRequest } from 'next/server';
import { listConnectedDecisions } from '@/app-layer/usecases/access-review-connected';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.view',
        async (_req: NextRequest, { params }, ctx) => {
            return jsonResponse({
                decisions: await listConnectedDecisions(ctx, params.reviewId),
            });
        },
    ),
);
