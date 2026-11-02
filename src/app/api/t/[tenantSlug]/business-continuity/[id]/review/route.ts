import { markBiaReviewed } from '@/app-layer/usecases/business-impact-analysis';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * POST — mark this BIA reviewed (#4931). The server stamps the time and the
 * caller as the reviewer; the body carries nothing.
 *
 * Gated on `continuity.edit`, like every other write on the register.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (_req, { params }, ctx) => {
        return jsonResponse(await markBiaReviewed(ctx, params.id));
    }),
);
