/**
 * Step 3a (#3674) — accept or reject one narrowing of an agent's grants.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/agent-narrowings/:narrowingId
 *   body: { "outcome": "ACCEPT" | "REJECT" }
 *
 * Gated by `access_reviews.decide`, as a subject verdict is. Accepting deletes
 * the grant the narrowing names — the only change a campaign makes to an
 * agent's authority, and it only narrows — so it does not also need
 * `admin.agent_tool_exposure` (roadmap, permission table). The per-campaign
 * narrowing (assigned reviewer or admin; never the agent's owner) is in
 * `decideAgentNarrowing`.
 */
import { NextRequest } from 'next/server';
import { decideAgentNarrowing } from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string; narrowingId: string }>(
        'access_reviews.decide',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json().catch(() => ({}));
            return jsonResponse(await decideAgentNarrowing(ctx, params.reviewId, params.narrowingId, body));
        },
    ),
);
