/**
 * `/api/t/:slug/admin/agents/:agentId/coverage` — which of the OWASP agentic
 * risks this registered agent has controls for, and which it does not.
 *
 * Read-only. Gated by `admin.agent_registry` like every other route under
 * `admin/agents` — the existing rule in `route-permissions.ts` matches the
 * whole subtree, so this path needed no new rule, and a denial writes the same
 * hash-chained `AUTHZ_DENIED` row.
 *
 * The response leads with four DISJOINT code lists rather than a percentage.
 * A percentage is the one number that cannot answer the assessor's question,
 * which is always "which risk is open".
 */
import { NextRequest } from 'next/server';

import { computeAgentRiskCoverage } from '@/app-layer/usecases/agent-coverage';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await computeAgentRiskCoverage(ctx, agentId));
        },
    ),
);
