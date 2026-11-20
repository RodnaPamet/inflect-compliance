/**
 * Agent Pay 1.4 (#5333) — accept or reject one proposed withdrawal of an
 * agent's spending authority in an AGENT campaign.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/agent-spending-withdrawals/:withdrawalId
 *   body: { "outcome": "ACCEPT" | "REJECT" }
 *
 * Gated by `access_reviews.decide`, as a grant narrowing is (owner decision 3
 * of 2026-11-20). Accepting withdraws the envelope the pack described — it only
 * takes authority away — so it does not also need `admin.agent_registry`, and
 * opens a task for the agent's owner to revoke the token at its requestor. The
 * per-campaign narrowing (assigned reviewer or admin; never the agent's owner)
 * is in `decideAgentSpendingWithdrawal`.
 */
import { NextRequest } from 'next/server';
import { decideAgentSpendingWithdrawal } from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string; withdrawalId: string }>(
        'access_reviews.decide',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json().catch(() => ({}));
            return jsonResponse(await decideAgentSpendingWithdrawal(ctx, params.reviewId, params.withdrawalId, body));
        },
    ),
);
