/**
 * Agent Pay 1.4 (#5333), ground (d) — the campaign's reviewer confirms that an
 * agent can no longer pay on one rail, which proposes withdrawing that
 * spending authority.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/agent-spending-withdrawals
 *   body: { "decisionId": string, "rail": "AGENT_PAY_TOKEN" | "AP4M" | "OTHER" }
 *
 * Gated by `access_reviews.decide`, as deciding a withdrawal is: a scan cannot
 * show an agent cannot pay, so a person states it (owner decision of
 * 2026-11-20). It opens a PENDING withdrawal and withdraws nothing by itself;
 * the reviewer then decides it at `…/agent-spending-withdrawals/:withdrawalId`.
 * The per-campaign narrowing (assigned reviewer or admin; never the agent's
 * owner) is in `confirmAgentHasNoPaymentAbility`.
 */
import { NextRequest } from 'next/server';
import { confirmAgentHasNoPaymentAbility } from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.decide',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json().catch(() => ({}));
            return jsonResponse(await confirmAgentHasNoPaymentAbility(ctx, params.reviewId, body), { status: 201 });
        },
    ),
);
