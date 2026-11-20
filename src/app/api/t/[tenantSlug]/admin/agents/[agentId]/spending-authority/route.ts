/**
 * `/api/t/:slug/admin/agents/:agentId/spending-authority` — an agent's declared
 * spending authority (Agent Pay Phase 1, D-L1-9; #5333).
 *
 * GET  — the agent's envelopes, one per rail, each with the acts this viewer
 *        would be allowed (`getAgentSpendingAuthorityState`).
 * POST — DECLARE an envelope, or widen or re-declare one: the body is the whole
 *        envelope, `rail` included. 201. The result is always DECLARED, and a
 *        second person reviews it before the agent may go into service.
 *
 * The envelope is a declaration to review, never a grant Inflect enforces at
 * payment time, and it never carries a payment credential (D-L1-8): the
 * writer refuses a card-number or credential shape in every free-text field.
 *
 * ## Why `admin.agent_registry`, at the route
 *
 * Spending authority is a privilege on the register, and deciding what an
 * agent may hold is register authority. ADMIN, OWNER and AI_ADMIN hold the
 * key; no API-key scope carries it. The literal `requirePermission` is the
 * gate because only its denial writes the hash-chained `AUTHZ_DENIED` row; an
 * explicit rule in `ROUTE_PERMISSIONS`, above the register's catch-all, states
 * the decision. `usecases/agent-spending-authority.ts` is the only writer, and
 * its four-eyes rule is held there and by a CHECK, not by a second key.
 */
import { NextRequest } from 'next/server';

import {
    declareAgentSpendingAuthority,
    getAgentSpendingAuthorityState,
} from '@/app-layer/usecases/agent-spending-authority';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentSpendingAuthorityState(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const result = await declareAgentSpendingAuthority(ctx, agentId, await req.json());
            return jsonResponse(result, { status: 201 });
        },
    ),
);
