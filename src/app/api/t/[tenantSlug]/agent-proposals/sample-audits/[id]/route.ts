import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import {
    recordSampleAuditOutcome,
    type RecordSampleAuditOutcomeInput,
} from '@/app-layer/usecases/agent-proposal-sample-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

/**
 * POST /api/t/:tenantSlug/agent-proposals/sample-audits/:id — answer one
 * retrospective sample audit (OWASP ASI09).
 *
 * Body: `{ outcome: 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE',
 *          dissentCodes?: string[] }`.
 *
 * Write-gated by the usecase (`assertCanWrite`), which ALSO refuses the case
 * that matters most here: the caller may not be the person who approved the
 * proposal under review. That refusal is a 403 with a hash-chained
 * `AUTHZ_DENIED` row — a self-review would drive the disagreement rate to zero
 * exactly in the tenants where rubber-stamping is worst, because there the
 * approver is the only person looking.
 *
 * The body is NOT parsed here beyond "is it an object": the usecase owns the
 * schema so every caller — this route, a script, a future SDK — is validated by
 * the same rules rather than by whichever boundary they happened to enter
 * through.
 */
export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        throw badRequest('A sample-audit outcome body is required');
    }
    const result = await recordSampleAuditOutcome(
        ctx,
        params.id,
        body as RecordSampleAuditOutcomeInput,
    );
    return jsonResponse(result);
});
