import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { bulkRejectAgentProposals } from '@/app-layer/usecases/agent-proposals';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkAgentProposalRejectSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/:tenantSlug/agent-proposals/bulk/reject — reject a batch of
 * pending proposals in one transaction. Nothing is created. Write-gated by the
 * usecase (`assertCanWrite`), the same gate its single-proposal sibling at
 * `../[id]/reject` uses; this route is deliberately not a route-level
 * `requirePermission` surface, because moving one of the pair and not the
 * other would let the bulk path and the single path disagree about who may
 * reject.
 *
 * THE RESPONSE NAMES BOTH HALVES: `{ rejected: string[], skipped: [{ id,
 * reason }] }`. A batch whose rows are all stale returns 200 with an empty
 * `rejected` — it is not an error that somebody else already decided them, and
 * the caller is told which ids and why rather than being handed a count it
 * cannot reconcile. See `bulkRejectAgentProposals` for the atomicity decision
 * this shape follows from.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const body = await parseJsonBody(req, BulkAgentProposalRejectSchema);
    const result = await bulkRejectAgentProposals(ctx, body.proposalIds);
    return jsonResponse(result);
});
