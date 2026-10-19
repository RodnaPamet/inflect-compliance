/**
 * `/api/t/:slug/admin/agents/peers/:peerId/inbound-credential` — the bearer one
 * A2A peer presents inbound, bound to one receiving agent and a workflow
 * allowlist (#3679).
 *
 *   GET     the live credential (never its hash), and what to hand the peer:
 *           Inflect's identity for this pair, the endpoint path, Inflect's
 *           public signing key
 *   POST    { receivingAgentId, workflowKeys }  issue — the token is in this
 *           response and nowhere else, ever
 *   DELETE  revoke the live credential; the next inbound message is refused
 *
 * `admin.agent_registry`, through the peers subtree rule in
 * `route-permissions.ts`: deciding which agent a peer's tasks reach is the same
 * configuration as deciding which peer the tenant talks to (owner decision
 * 2026-10-18, R3). The usecase refuses an API-key caller.
 */
import { NextRequest } from 'next/server';

import {
    getPeerInboundCredential,
    issuePeerInboundCredential,
    revokePeerInboundCredential,
} from '@/app-layer/usecases/a2a-peer-credentials';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        return jsonResponse(await getPeerInboundCredential(ctx, peerId));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        return jsonResponse(await issuePeerInboundCredential(ctx, peerId, await req.json()), { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        return jsonResponse(await revokePeerInboundCredential(ctx, peerId));
    }),
);
