import { NextRequest } from 'next/server';
import { bulkSetTaskStatus } from '@/app-layer/usecases/task';
import { BulkTaskStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tasks/bulk/status
 *
 * Gated on `tasks.edit`. Body parsed inline — see `bulk/assign`.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'tasks.edit',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkTaskStatusSchema);
            const result = await bulkSetTaskStatus(
                ctx,
                body.taskIds,
                body.status,
                body.resolution,
            );
            return jsonResponse(result);
        },
    ),
);
