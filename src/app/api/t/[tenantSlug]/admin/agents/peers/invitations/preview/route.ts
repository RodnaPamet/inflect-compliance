/**
 * `/api/t/:slug/admin/agents/peers/invitations/preview` — read the inviting
 * workspace's agent card for a person to review before accepting (#3752).
 * Writes nothing. `admin.agent_registry`.
 */
import { NextRequest } from 'next/server';

import { PreviewPeerInvitationSchema, previewPeerInvitation } from '@/app-layer/usecases/peer-invitations';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = PreviewPeerInvitationSchema.parse(await req.json());
            return jsonResponse(await previewPeerInvitation(ctx, body));
        },
    ),
);
