/**
 * `/api/t/:slug/admin/agents/:agentId` — read, amend, retire one registered agent.
 *
 * DELETE is RETIREMENT, not deletion. The row survives: the register has to keep
 * saying that the agent existed and what authority it held, and the runtime
 * records that point at it are its audit trail. Retirement CASCADES (#3698), in
 * one transaction under this route's one key: every credential bound to the agent
 * is revoked, its tool grants are dropped, its PENDING proposals expire and its
 * policy card is frozen. It is permanent — a retired agent cannot be activated or
 * suspended again — and the response reports what the cascade changed. An
 * operator who needs an agent stopped NOW but not closed reaches for the
 * reversible `POST ./status { "status": "SUSPENDED" }`. See
 * `retireRegisteredAgent` for the order and why it is load-bearing.
 */
import { NextRequest } from 'next/server';

import {
    getRegisteredAgent,
    retireRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

// `{ params }` destructured and then AWAITED, per the house pattern. Under the
// Next 15+ runtime the route export receives `params` as a Promise and
// `requirePermission` forwards `routeArgs` through untouched, so the await is
// what resolves it — annotating the parameter as `Promise<Params>` here would
// contradict `PermissionedHandler`'s own signature and fail to compile.

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getRegisteredAgent(ctx, agentId));
        },
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await updateRegisteredAgent(ctx, agentId, await req.json()));
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await retireRegisteredAgent(ctx, agentId));
        },
    ),
);
