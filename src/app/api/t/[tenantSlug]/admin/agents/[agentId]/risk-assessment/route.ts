/**
 * `/api/t/:slug/admin/agents/:agentId/risk-assessment` — the instrument.
 *
 * GET returns the four IMDA dimensions, the twenty questions, this agent's
 * answers so far, and the standing tier with its freshness. PUT upserts ONE
 * answer.
 *
 * ## Why this route is not optional furniture
 *
 * A scored `riskTier` caps the agent's authority at every tool call, and an
 * UNSCORED agent is refused everything. That refusal is only defensible while
 * scoring is reachable — a control whose remedy has no surface is an outage
 * with a rationale. This is the remedy's surface: the route an operator uses to
 * get an agent out of the unscored state, and the one `activateRegisteredAgent`
 * points at when it refuses to switch on an unassessed agent.
 *
 * Gated on `admin.agent_registry`, the same key as the register itself and
 * matched by its existing catch-all rule in `ROUTE_PERMISSIONS`. That is the
 * right key rather than a narrower one: completing an assessment WRITES the
 * tier onto the agent, and the tier is what decides how far the agent may be
 * driven — this is the authority to set an agent's authority, which is exactly
 * what `admin.agent_registry` means. Denials write a hash-chained
 * `AUTHZ_DENIED` row because the gate is at the route; a usecase throw records
 * nothing.
 *
 * PUT rather than POST for the answer: upserting one (assessment, question)
 * pair is idempotent, and a double-submitted form must not produce two answers.
 */
import { NextRequest } from 'next/server';

import {
    getAgentRiskAssessmentState,
    saveAgentAssessmentAnswer,
} from '@/app-layer/usecases/agent-risk-assessment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

// `{ params }` destructured and then AWAITED, per the house pattern — see the
// sibling register route for why an explicit `Promise<Params>` annotation
// cannot compile against `PermissionedHandler`.

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentRiskAssessmentState(ctx, agentId));
        },
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await saveAgentAssessmentAnswer(ctx, agentId, await req.json()));
        },
    ),
);
