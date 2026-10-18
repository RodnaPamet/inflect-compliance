/**
 * `/api/t/:slug/admin/agents/peers/:peerId/card` — read the peer's LIVE agent
 * card for review, with its hashes, the verdict against the pin, and whether
 * the peer would be admitted now (#3673).
 *
 * The card's content is in this response because a person cannot approve a
 * hash of text they were not shown. It is the peer's text, untrusted, and is
 * rendered only as text; it is never stored or logged.
 */
import { NextRequest } from 'next/server';

import { readPeerAgentCard } from '@/app-layer/usecases/peer-agents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { peerId } = await params;
            return jsonResponse(await readPeerAgentCard(ctx, peerId));
        },
    ),
);
