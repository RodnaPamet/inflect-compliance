/**
 * `/api/t/:slug/admin/agents/:agentId/ownership-transfer` — step one of a
 * two-step agent ownership transfer, and the transfer's read and cancel (#3698).
 *
 * GET    — the agent's open transfer, if any, and its recent history.
 * POST   — step one: `{ toOwnerUserId }` proposes who should become the agent's
 *          accountable owner. 201 with the transfer.
 * DELETE — `?transferId=` cancels an open transfer: the initiator withdrawing
 *          it, the person it names declining it, or another OWNER.
 *
 * Step two — the named person accepting it — is `./complete`.
 *
 * ## Why `admin.tenant_lifecycle`, and why at the route
 *
 * Step 0e of the agentic IAM roadmap puts both steps under tenant lifecycle,
 * the key whose docstring already lists "transfer ownership", and NOT under
 * `admin.agent_registry`: ADMIN holds the register key, and an agent's
 * accountable owner must not be movable by the role that owner is accountable
 * to. The literal `requirePermission` is the gate because only its denial writes
 * the hash-chained `AUTHZ_DENIED` row. Its rule in `ROUTE_PERMISSIONS` sits ABOVE
 * the `admin/agents(/.*)?` catch-all, which is first-match-wins and would
 * otherwise record `admin.agent_registry`.
 *
 * No API key carries `admin.tenant_lifecycle` — `scopesToPermissions` builds
 * `*` from ADMIN's set — so these routes are human-only by construction. There
 * is no page yet; the transfer is API-only until its overview panel ships.
 */
import { NextRequest } from 'next/server';

import {
    cancelAgentOwnershipTransfer,
    getAgentOwnershipTransfers,
    proposeAgentOwnershipTransfer,
} from '@/app-layer/usecases/agent-ownership-transfer';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentOwnershipTransfers(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(
                await proposeAgentOwnershipTransfer(ctx, agentId, await req.json()),
                { status: 201 },
            );
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            // The whole query string, so the `.strict()` schema refuses a key it
            // does not know rather than ignoring it.
            const query = Object.fromEntries(req.nextUrl.searchParams);
            return jsonResponse(await cancelAgentOwnershipTransfer(ctx, agentId, query));
        },
    ),
);
