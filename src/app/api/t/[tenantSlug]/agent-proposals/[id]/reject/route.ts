import { NextRequest } from 'next/server';

import { rejectAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST /api/t/:tenantSlug/agent-proposals/:id/reject — reject a pending
 * proposal. Nothing is created.
 *
 * The approve sibling's gate, in the same two layers: the proposals page's
 * `admin.view` OR `admin.agent_registry_view` (`mayReadAgentActivity`, #3710)
 * here, as the middleware so a refusal writes `AUTHZ_DENIED`, and the role-tier
 * write the usecase asserts (`assertCanWrite`). The bulk route takes the same
 * pair, so the single and bulk paths cannot disagree about who may reject.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (_req: NextRequest, routeArgs, ctx) => {
            const params = await routeArgs.params;
            await rejectAgentProposal(ctx, params.id);
            return jsonResponse({ ok: true });
        },
    ),
);
