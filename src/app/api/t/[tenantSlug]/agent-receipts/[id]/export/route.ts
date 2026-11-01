import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { getReceiptForExport } from '@/app-layer/usecases/agent-action-receipt';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:slug/agent-receipts/:id/export
 *
 * Emit the full receipt + Ed25519 signature + signingKeyId so an EXTERNAL
 * auditor can verify it independently with pipelock's own verifier CLI —
 * WITHOUT trusting this system. The stored `scannedSummary` is scrubbed/bounded
 * (never the raw payload); full re-verification uses pipelock's original
 * evidence.jsonl keyed by this signature. Read authorisation via the usecase's
 * `assertCanRead` + the oversight read rule + the middleware tenant gate.
 * Answered as an attachment, so a browser saves it rather than showing it.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const receipt = await getReceiptForExport(ctx, params.id);
        // A FILE, not a page (#4897): the Export link used to navigate the tab
        // to the JSON. The id is a cuid, so it is safe in the header as is.
        return jsonResponse(receipt, {
            headers: { 'Content-Disposition': `attachment; filename="agent-receipt-${receipt.id}.json"` },
        });
    },
);
