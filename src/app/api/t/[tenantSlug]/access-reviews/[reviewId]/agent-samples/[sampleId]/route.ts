/**
 * Step 3a (#3674) — the second human's answer to one sampled agent decision.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/agent-samples/:sampleId
 *   body: { "outcome": "CONCURRED" | "DISSENTED" | "INDETERMINATE", "dissentCodes"?: [...] }
 *
 * Gated by `access_reviews.decide`, the key a first verdict takes. The usecase
 * narrows further: the answer needs the pack, so only the campaign's reviewer
 * or a holder of `admin.agent_registry` may give it, and never the person who
 * made the sampled decision or the agent's owner (403 + `AUTHZ_DENIED`).
 */
import { NextRequest } from 'next/server';
import { recordAgentDecisionSampleOutcome } from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string; sampleId: string }>(
        'access_reviews.decide',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json().catch(() => ({}));
            return jsonResponse(await recordAgentDecisionSampleOutcome(ctx, params.reviewId, params.sampleId, body));
        },
    ),
);
