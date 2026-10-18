/**
 * PR-7 — record a verdict on a connected-account decision.
 *
 * Step 5a: gated by `access_reviews.decide`. Granted to every role for the
 * reason set out on the member-verdict route — the narrowing is per-campaign
 * (assigned reviewer or `canAdmin`) and stays inside
 * `submitConnectedDecision`, which can see which campaign is in play.
 *
 * #3674 — an AGENT subject is a connected-decision row too, and it is decided by
 * `submitAgentDecision`, which holds the rules the generic decide does not: the
 * agent's owner may not decide it, its pack must exist and its narrowings be
 * decided first. The dispatch reads the row's campaign scope AFTER
 * authorisation; the generic decide refuses AGENT by name
 * (`AGENT_CAMPAIGN_OWN_FLOW`) for any caller that skips it.
 */
import { NextRequest } from 'next/server';
import {
    scopeOfConnectedDecision,
    submitConnectedDecision,
} from '@/app-layer/usecases/access-review-connected';
import { submitAgentDecision } from '@/app-layer/usecases/access-review-agent';
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
        if ((await scopeOfConnectedDecision(ctx, params.decisionId)) === 'AGENT') {
            return jsonResponse(await submitAgentDecision(ctx, params.decisionId, body));
        }
        return jsonResponse(
            await submitConnectedDecision(ctx, params.decisionId, body),
        );
    }),
);
