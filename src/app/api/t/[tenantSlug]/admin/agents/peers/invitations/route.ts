/**
 * `/api/t/:slug/admin/agents/peers/invitations` — invite another workspace to
 * connect over A2A (#3752; owner decisions 2026-11-11).
 *
 * `admin.agent_registry`, the key every A2A peer route takes (owner decision
 * 2026-10-18, residual R3 of docs/a2a-threat-model.md). The usecase also asks
 * for a person and the coarse admin tier, because accepting an invitation
 * stores an outbound connection.
 */
import { NextRequest } from 'next/server';

import { CreatePeerInvitationSchema, createPeerInvitation, listPeerInvitations } from '@/app-layer/usecases/peer-invitations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse({ invitations: await listPeerInvitations(ctx) }),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = CreatePeerInvitationSchema.parse(await req.json());
            return jsonResponse(await createPeerInvitation(ctx, body), { status: 201 });
        },
    ),
);
