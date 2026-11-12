import { materializeDeltaFindings } from '@/app-layer/usecases/framework-delta';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST — explicitly materialise idempotent, source-tagged findings for the
 * delta's new gaps. `findings.create`, the key the findings register's own
 * create takes: a custom role refused findings is refused here too.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('findings.create', async (_req, { params }, ctx) => {
        return jsonResponse(await materializeDeltaFindings(ctx, params.id));
    }),
);
