/**
 * `/api/t/:slug/admin/agents/:agentId` — read, amend, retire one registered agent.
 *
 * DELETE is RETIREMENT, not deletion. The row survives: the register has to keep
 * saying that the agent existed and what authority it held, and the runtime
 * records that point at it are its audit trail. Retirement is REFUSED while the
 * agent has proposals awaiting a human — see `retireRegisteredAgent` for why
 * refusing beats cascading, and note that an operator who needs it stopped NOW
 * reaches for `POST ./status { "status": "SUSPENDED" }`, which has no
 * precondition at all.
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
