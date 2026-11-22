/**
 * `/api/t/:slug/admin/agents/:agentId/behaviour-fingerprint` — the nightly
 * behaviour detector's findings for one agent, and a person's acceptance of a
 * changed behaviour as the agent's new normal (Morpheus roadmap 1.3).
 *
 * GET  — recent scored days, recent anomalies with the features that drove
 *        them, whether the detector is on for this workspace, and whether the
 *        caller may accept a new baseline now.
 * POST — accept the changed behaviour as normal: moves the breaker's
 *        `baselineEpoch`, so both behaviour detectors re-learn. Refused on an
 *        open breaker (its close decides), with nothing to accept, and for an
 *        API key or an agent. See `acceptAgentBehaviourBaseline`.
 *
 * `admin.agent_registry`, the circuit-breaker route's key, for both verbs: the
 * fingerprint is the breaker's sibling detector, and its acceptance writes the
 * breaker's own column. The gate is at the route so a refusal writes the
 * hash-chained `AUTHZ_DENIED` row; the usecase asks again.
 *
 * The body is a confirmation literal, `.strict()`: re-baselining discards an
 * agent's history, and a decision nobody made must not be inferred from an
 * empty body.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
    acceptAgentBehaviourBaseline,
    getAgentBehaviourFingerprint,
} from '@/app-layer/usecases/agent-behaviour-fingerprint-read';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

const AcceptBaselineSchema = z.object({ confirm: z.literal('ACCEPT_NEW_BASELINE') }).strict();

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
        const { agentId } = await params;
        return jsonResponse(await getAgentBehaviourFingerprint(ctx, agentId));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
        const { agentId } = await params;
        await parseJsonBody(req, AcceptBaselineSchema);
        return jsonResponse(await acceptAgentBehaviourBaseline(ctx, agentId));
    }),
);
