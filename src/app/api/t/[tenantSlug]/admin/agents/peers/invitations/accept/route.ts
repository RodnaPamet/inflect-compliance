/**
 * `/api/t/:slug/admin/agents/peers/invitations/accept` — accept an A2A peer
 * invitation (#3752; owner decisions 2026-11-11). One act by a person: pins
 * the inviting workspace's card as reviewed, exchanges tokens with it, and
 * stores the outbound connection. `admin.agent_registry`.
 */
import { NextRequest } from 'next/server';

import { AcceptPeerInvitationSchema, acceptPeerInvitation } from '@/app-layer/usecases/peer-invitations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = AcceptPeerInvitationSchema.parse(await req.json());
            return jsonResponse(await acceptPeerInvitation(ctx, body), { status: 201 });
        },
    ),
);
