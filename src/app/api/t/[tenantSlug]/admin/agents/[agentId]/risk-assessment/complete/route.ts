/**
 * `/api/t/:slug/admin/agents/:agentId/risk-assessment/complete` — score it.
 *
 * Its own URL rather than a verb on the parent, for the same reason the
 * lifecycle move has its own route: this is not a field edit. Completing a run
 * SCORES the agent and writes the tier onto `RegisteredAgent`, and that tier is
 * what caps how far up the autonomy ladder the agent may be driven on every
 * subsequent tool call. It deserves its own audit-legible path and its own
 * thing for a UI to point a button at, and it must not be reachable by a
 * partial-update body that happened to carry an extra key.
 *
 * Takes NO body. There is nothing for a caller to supply: the tier comes from
 * the agent's own axes plus the answers already saved, and a field the client
 * could fill in would make the assessment a form rather than a judgement — the
 * same posture that keeps `riskTier` out of every schema in
 * `agent-assessment.schemas.ts`.
 *
 * Gated on `admin.agent_registry`; see the parent route for why that key and
 * not a narrower one.
 */
import { NextRequest } from 'next/server';

import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await completeAgentRiskAssessment(ctx, agentId));
        },
    ),
);
