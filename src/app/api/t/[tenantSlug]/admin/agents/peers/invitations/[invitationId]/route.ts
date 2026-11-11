/**
 * `/api/t/:slug/admin/agents/peers/invitations/:invitationId` — revoke a
 * pending A2A peer invitation (#3752). `admin.agent_registry`, as creating one.
 */
import { NextRequest } from 'next/server';

import { revokePeerInvitation } from '@/app-layer/usecases/peer-invitations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; invitationId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { invitationId } = await params;
            return jsonResponse(await revokePeerInvitation(ctx, invitationId));
        },
    ),
);
