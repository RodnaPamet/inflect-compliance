/**
 * `/api/t/:slug/admin/agents/peers/:peerId/card/approve` — approve the live
 * card as the peer's pin (#3673). The body names the card hash the approver
 * reviewed; the card is read again and the approval refused (409) if it no
 * longer matches (`docs/a2a-threat-model.md`, pinning rule 5).
 */
import { NextRequest } from 'next/server';

import { approvePeerAgentCard, ApprovePeerCardSchema } from '@/app-layer/usecases/peer-agents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { peerId } = await params;
            const body = ApprovePeerCardSchema.parse(await req.json());
            return jsonResponse(await approvePeerAgentCard(ctx, peerId, body));
        },
    ),
);
