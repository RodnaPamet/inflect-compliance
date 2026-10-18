/**
 * `/api/t/:slug/admin/agents/peers/:peerId` — read one A2A peer, or change its
 * name, owner, risk tier or status (#3673). RETIRED is one-way.
 */
import { NextRequest } from 'next/server';

import { getPeerAgent, updatePeerAgent, UpdatePeerAgentSchema } from '@/app-layer/usecases/peer-agents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { peerId } = await params;
            return jsonResponse(await getPeerAgent(ctx, peerId));
        },
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { peerId } = await params;
            const body = UpdatePeerAgentSchema.parse(await req.json());
            return jsonResponse(await updatePeerAgent(ctx, peerId, body));
        },
    ),
);
