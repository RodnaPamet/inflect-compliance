/**
 * `/api/t/:slug/admin/agents/peers/:peerId/messages` — the signed A2A receipts
 * exchanged with one peer, both directions, each re-verified from the stored
 * row on read (#3679). Statements and signatures only; no body leaves here.
 *
 * `admin.agent_registry`, through the peers subtree rule in
 * `route-permissions.ts`.
 */
import { NextRequest } from 'next/server';

import { listPeerMessages } from '@/app-layer/usecases/a2a-messages';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        const take = req.nextUrl.searchParams.get('take');
        return jsonResponse(await listPeerMessages(ctx, peerId, take ? { take } : {}));
    }),
);
