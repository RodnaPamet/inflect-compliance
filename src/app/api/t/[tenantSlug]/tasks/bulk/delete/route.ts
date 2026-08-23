import { NextRequest } from 'next/server';
import { bulkDeleteTask } from '@/app-layer/usecases/task';
import { BulkTaskDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tasks/bulk/delete
 *
 * Gated on `admin.manage`. This route previously declared `tasks.edit`
 * while `bulkDeleteTask` asserted `assertCanAdmin` — a gate declared
 * WEAKER than the assert behind it, which is worse than no gate at all
 * for the audit trail: an EDITOR passed the middleware, the usecase threw
 * the 403, and a usecase throw writes no AUTHZ_DENIED row. So the exact
 * denial the gate exists to log was the only one it could not see. The
 * route's own comment anticipated this ("this route key is aligned with
 * whatever that lands on"); the bulk-delete parity item landed on ADMIN.
 *
 * NOT an access change — an EDITOR was already refused, by the usecase.
 * What changes is that the refusal is now recorded. See #2117.
 *
 * Body parsed inline — see `bulk/assign` for why `withValidatedBody` and
 * `requirePermission` are not nested.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.manage',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkTaskDeleteSchema);
            const result = await bulkDeleteTask(ctx, body.taskIds);
            return jsonResponse(result);
        },
    ),
);
