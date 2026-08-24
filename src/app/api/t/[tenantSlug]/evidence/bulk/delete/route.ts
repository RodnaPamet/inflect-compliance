import { NextRequest } from 'next/server';
import { bulkDeleteEvidence } from '@/app-layer/usecases/evidence';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkEvidenceDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/evidence/bulk/delete
 *
 * `admin.manage` matches the `assertCanAdmin` that `bulkDeleteEvidence`
 * itself asserts. The usecase assert STAYS — it is what protects
 * non-HTTP callers (jobs, scripts) — but only a middleware denial writes
 * an AUTHZ_DENIED audit row, so without the route gate a refused bulk
 * delete of the evidence register left no trace. See #2117 and
 * docs/epic-c-security.md (C.1).
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument,
 * so nesting them would need a 4-tuple signature.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkEvidenceDeleteSchema);
        const result = await bulkDeleteEvidence(ctx, body.evidenceIds);
        return jsonResponse(result);
    }),
);
