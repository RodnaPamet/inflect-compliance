import { NextRequest } from 'next/server';
import { bulkSetTaskDueDate } from '@/app-layer/usecases/task';
import { BulkTaskDueDateSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tasks/bulk/due
 *
 * Gated on `tasks.edit`. Body parsed inline — see `bulk/assign`.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'tasks.edit',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkTaskDueDateSchema);
            const result = await bulkSetTaskDueDate(ctx, body.taskIds, body.dueAt);
            return jsonResponse(result);
        },
    ),
);
