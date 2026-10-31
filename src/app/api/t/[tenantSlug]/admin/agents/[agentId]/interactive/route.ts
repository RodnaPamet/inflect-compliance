/**
 * `/api/t/:slug/admin/agents/:agentId/interactive` — make this agent the one
 * that answers on Ask, or stop it (#4629).
 *
 * PUT    — designate this agent, replacing any other. 200.
 * DELETE — stop this agent answering. A no-op, still 200, when another agent
 *          has since been designated: clearing names the agent it clears.
 *
 * ## Why `admin.agent_registry`, at the route
 *
 * Owner decision, 2026-10-30: designating the agent that answers the
 * workspace's people is register authority, set on the agent's own page.
 * OWNER, ADMIN and AI_ADMIN hold the key; no API-key scope carries it. The
 * literal `requirePermission` is the gate because only its denial writes the
 * hash-chained `AUTHZ_DENIED` row; the register's `admin/agents(/.*)?` rule in
 * `ROUTE_PERMISSIONS` records the same key.
 */
import { NextRequest } from 'next/server';

import {
    clearInteractiveAgent,
    designateInteractiveAgent,
} from '@/app-layer/usecases/interactive-agent-designation';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const PUT = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await designateInteractiveAgent(ctx, agentId));
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await clearInteractiveAgent(ctx, agentId));
        },
    ),
);
