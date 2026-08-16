import { NextRequest } from 'next/server';
import { bulkImportRisks } from '@/app-layer/usecases/risk';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkImportRisksSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Bulk risk import — replaces the CSV importer's N sequential per-row POSTs
 * with a single request. The usecase dedupes by title, resolves free-text
 * owners to members, and reports created / skipped / per-row errors.
 *
 * `risks.create` matches the tier `bulkImportRisks` itself asserts. That
 * alignment is the point of the gate: a weaker declared key would let the
 * request past the middleware and leave the usecase to throw — and a usecase
 * throw writes NO AUTHZ_DENIED row, so the denial never reaches the security
 * trail. See docs/epic-c-security.md (C.1).
 */
export const POST = withApiErrorHandling(
    requirePermission('risks.create', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkImportRisksSchema);
        const result = await bulkImportRisks(ctx, body.risks);
        return jsonResponse(result);
    }),
);
