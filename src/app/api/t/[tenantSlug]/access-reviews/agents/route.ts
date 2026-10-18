/**
 * Step 3a (#3674) — create an AGENT access review over the registered agents.
 *
 *   POST /api/t/:slug/access-reviews/agents
 *
 * A leaf of its own, as CONNECTED_APP has `/connected`: the body has no scope
 * and no membership list, and `POST /access-reviews` refuses AGENT by name
 * (`SCOPE_HAS_ITS_OWN_ROUTE`). Gated by `access_reviews.create` at the route
 * (denials write `AUTHZ_DENIED`) and by `assertCanAdmin` in
 * `createAgentAccessReview` for non-HTTP callers. The campaign freezes its
 * population here and refuses an empty one (`NO_SUBJECTS`); the packs are
 * prepared by `POST /access-reviews/:id/agent-packs`.
 */
import { NextRequest } from 'next/server';
import { createAgentAccessReview } from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'access_reviews.create',
        async (req: NextRequest, _routeArgs, ctx) => {
            // The usecase parses with `CreateAgentAccessReviewSchema`.
            const body = await req.json().catch(() => ({}));
            const result = await createAgentAccessReview(ctx, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
