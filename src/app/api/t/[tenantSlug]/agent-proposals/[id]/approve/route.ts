import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { approveAgentProposal } from '@/app-layer/usecases/agent-proposals';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/:tenantSlug/agent-proposals/:id/approve — the human-in-the-loop
 * gate. Approving runs the REAL create-usecase (audited as the reviewer, with
 * the proposing agent's key in metadata). Write-gated by the usecase
 * (`assertCanWrite`). Optional `{ edits: {...} }` body merges edits before
 * creation.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    let edits: Record<string, unknown> | undefined;
    let baseDigest: string | undefined;
    try {
        const body = (await req.json()) as
            | { edits?: Record<string, unknown>; baseDigest?: string }
            | null;
        edits = body?.edits;
        // The fingerprint of the diff the reviewer read. Forwarded, never
        // defaulted: for an UPDATE proposal the usecase REFUSES an approval that
        // carries none, and a route that invented one here would forge the
        // reviewer's claim to have looked. See `ApproveOptions.baseDigest`.
        baseDigest = typeof body?.baseDigest === 'string' ? body.baseDigest : undefined;
    } catch {
        // No/invalid body → approve as-proposed. An UPDATE proposal then fails
        // the baseDigest check, which is the correct outcome for a request that
        // could not even be parsed.
    }
    const result = await approveAgentProposal(ctx, params.id, { edits, baseDigest });
    return jsonResponse(result);
});
