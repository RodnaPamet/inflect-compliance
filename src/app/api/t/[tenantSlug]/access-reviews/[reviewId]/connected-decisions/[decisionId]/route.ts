/**
 * PR-7 — record a verdict on a connected-account decision.
 *
 * Step 5a: gated by `access_reviews.decide`. Granted to every role for the
 * reason set out on the member-verdict route — the narrowing is per-campaign
 * (assigned reviewer or `canAdmin`) and stays inside
 * `submitConnectedDecision`, which can see which campaign is in play.
 */
import { NextRequest } from 'next/server';
import { submitConnectedDecision } from '@/app-layer/usecases/access-review-connected';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{
        tenantSlug: string;
        reviewId: string;
        decisionId: string;
    }>('access_reviews.decide', async (req: NextRequest, { params }, ctx) => {
        // The usecase parses with `SubmitConnectedDecisionSchema`, so the route
        // forwards the raw body — unchanged from before Step 5a.
        const body = await req.json().catch(() => ({}));
        return jsonResponse(
            await submitConnectedDecision(ctx, params.decisionId, body),
        );
    }),
);
