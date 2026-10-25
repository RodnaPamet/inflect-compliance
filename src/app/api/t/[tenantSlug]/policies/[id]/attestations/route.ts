import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { getTenantCtx } from '@/app-layer/context';
import { getPolicyAcknowledgementRoster } from '@/app-layer/usecases/policy-attestation';
import { jsonResponse } from '@/lib/api-response';

// GET /api/t/[tenantSlug]/policies/[id]/attestations — acknowledgement roster
// for the current published version: who was required, who has acknowledged
// (timestamps), % complete, voluntary acknowledgers, and the attestation log.
// Read-only; OWNER / ADMIN / AUDITOR, gated in the usecase (`assertCanAudit`,
// widened from admin-only by owner decision, #4128). Requesting
// acknowledgements stays admin-only (`acknowledgement-requests`).
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const roster = await getPolicyAcknowledgementRoster(ctx, params.id);
        return jsonResponse(roster);
    },
);
