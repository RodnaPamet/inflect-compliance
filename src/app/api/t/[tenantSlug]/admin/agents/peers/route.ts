/**
 * `/api/t/:slug/admin/agents/peers` — the A2A peer agents this tenant has
 * registered (#3673, step 2e).
 *
 * `admin.agent_registry`, by owner decision (2026-10-18, threat-model residual
 * R3): registering a peer decides which other organisation's agent this tenant
 * will talk to, which is configuration. The key for an agent's call leaving
 * the tenant, `admin.agent_external_tools`, is kept apart from it.
 */
import { NextRequest } from 'next/server';

import { listPeerAgents, registerPeerAgent, RegisterPeerAgentSchema } from '@/app-layer/usecases/peer-agents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await listPeerAgents(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = RegisterPeerAgentSchema.parse(await req.json());
            return jsonResponse(await registerPeerAgent(ctx, body), { status: 201 });
        },
    ),
);
