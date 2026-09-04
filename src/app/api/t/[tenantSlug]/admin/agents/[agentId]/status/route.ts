/**
 * `/api/t/:slug/admin/agents/:agentId/status` — the kill switch, and the switch back.
 *
 * Its own route rather than a `status` field on the PATCH above, because these
 * two moves are not field edits. SUSPENDED stops the agent's credentials at the
 * `/api/mcp` registration gate on the very next request; ACTIVE is what lets
 * them through in the first place. Both deserve their own audit action and their
 * own thing to point a UI button at, and neither should be reachable by a
 * partial-update body that happened to carry an extra key.
 *
 * RETIRED is deliberately NOT in `AGENT_LIFECYCLE_MOVES`: retirement carries a
 * precondition (no proposals awaiting review) and lives on DELETE, where the
 * refusal has somewhere to be said.
 */
import { NextRequest } from 'next/server';

import {
    activateRegisteredAgent,
    suspendRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { SetAgentLifecycleSchema } from '@/app-layer/schemas/agent-registry.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        // `{ params }` destructured then awaited — the house pattern; see the
        // sibling route file for why an explicit `Promise<Params>` annotation
        // cannot compile against `PermissionedHandler`.
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const { status } = await parseJsonBody(req, SetAgentLifecycleSchema);
            const result =
                status === 'ACTIVE'
                    ? await activateRegisteredAgent(ctx, agentId)
                    : await suspendRegisteredAgent(ctx, agentId);
            return jsonResponse(result);
        },
    ),
);
