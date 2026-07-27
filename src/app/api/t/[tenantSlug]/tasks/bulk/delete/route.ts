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
 * Gated on `tasks.edit`, matching the single-task DELETE. The usecase-tier
 * question (risks/assets/controls all require ADMIN for bulk delete) is
 * settled separately in the bulk-delete parity item; this route key is
 * aligned with whatever that lands on.
 *
 * Body parsed inline — see `bulk/assign` for why `withValidatedBody` and
 * `requirePermission` are not nested.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'tasks.edit',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkTaskDeleteSchema);
            const result = await bulkDeleteTask(ctx, body.taskIds);
            return jsonResponse(result);
        },
    ),
);
