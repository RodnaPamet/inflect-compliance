import { NextRequest } from 'next/server';
import { bulkAssignTasks } from '@/app-layer/usecases/task';
import { BulkTaskAssignSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tasks/bulk/assign
 *
 * Gated on `tasks.assign` — the same key the single-task assign route
 * uses. Before this, the only check was `assertCanWriteTasks`, which reads
 * `ctx.permissions.canWrite` off the BASE role, so a custom role with
 * `tasks.assign: false` was blocked on the single-task path yet could
 * still reassign in bulk.
 *
 * The body is parsed inline rather than through `withValidatedBody`:
 * that wrapper and `requirePermission` both claim the third handler
 * argument, so nesting them would need a 4-tuple signature — the same
 * reasoning recorded on `security/sessions/revoke-user`.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'tasks.assign',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, BulkTaskAssignSchema);
            const result = await bulkAssignTasks(ctx, body.taskIds, body.assigneeUserId);
            return jsonResponse(result);
        },
    ),
);
