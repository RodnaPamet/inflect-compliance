import { NextRequest } from 'next/server';

import { bulkRejectAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkAgentProposalRejectSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * POST /api/t/:tenantSlug/agent-proposals/bulk/reject — reject a batch of
 * pending proposals in one transaction. Nothing is created.
 *
 * Gated exactly as its single-proposal sibling at `../[id]/reject`: the
 * proposals page's `admin.view` OR `admin.agent_registry_view`
 * (`mayReadAgentActivity`, #3710) here, as the middleware so a refusal writes
 * `AUTHZ_DENIED`, and the role-tier write the usecase asserts
 * (`assertCanWrite`). The two routes moved together, so the bulk path and the
 * single path still agree about who may reject.
 *
 * THE RESPONSE NAMES BOTH HALVES: `{ rejected: string[], skipped: [{ id,
 * reason }] }`. A batch whose rows are all stale returns 200 with an empty
 * `rejected` — it is not an error that somebody else already decided them, and
 * the caller is told which ids and why rather than being handed a count it
 * cannot reconcile. See `bulkRejectAgentProposals` for the atomicity decision
 * this shape follows from.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        { keys: ['admin.view', 'admin.agent_registry_view'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkAgentProposalRejectSchema);
            const result = await bulkRejectAgentProposals(ctx, body.proposalIds);
            return jsonResponse(result);
        },
    ),
);
