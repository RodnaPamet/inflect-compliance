/**
 * `/api/t/:slug/admin/agents/peers/:peerId/kill` — stop one A2A peer in both
 * directions, and lift the stop (#3679).
 *
 *   GET    the kills on this peer, newest first
 *   POST   { reason }      engage: every next message to or from the peer is refused
 *   PATCH  { liftReason }  lift: a person, with a reason
 *
 * `admin.agent_kill_switch`, the key that stops an agent (roadmap permission
 * table; decision 4: no second authority model). Its own rule in
 * `route-permissions.ts`, ABOVE the peers subtree's `admin.agent_registry`,
 * because first match wins.
 */
import { NextRequest } from 'next/server';

import { engagePeerKill, liftPeerKill, listPeerKills } from '@/app-layer/usecases/a2a-peer-kill';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; peerId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (_req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        return jsonResponse(await listPeerKills(ctx, peerId));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
        return jsonResponse(await engagePeerKill(ctx, peerId, { reason: body.reason }), { status: 201 });
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (req: NextRequest, { params }, ctx) => {
        const { peerId } = await params;
        const body = (await req.json().catch(() => ({}))) as { liftReason?: unknown };
        return jsonResponse(await liftPeerKill(ctx, peerId, { liftReason: body.liftReason }));
    }),
);
