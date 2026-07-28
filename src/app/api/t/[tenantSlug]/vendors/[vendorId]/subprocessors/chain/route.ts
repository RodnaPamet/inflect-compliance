import { listSubprocessorChain } from '@/app-layer/usecases/vendor-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:slug/vendors/:vendorId/subprocessors/chain
 *
 * Recursive nth-party (4th-party+) subprocessor chain as a nested tree.
 * Bounded depth + cycle-safe. Backs the recursive subprocessor view on the
 * vendor detail page.
 *
 * Gated on `vendors.view` at the Epic C.1 layer — see the sibling route for
 * why the middleware matters even though the usecase already asserts. This
 * endpoint discloses the FULL nth-party graph in one call, so it is the more
 * disclosure-sensitive of the two reads.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; vendorId: string }>(
        'vendors.view',
        async (_req, { params }, ctx) =>
            jsonResponse(await listSubprocessorChain(ctx, params.vendorId)),
    ),
);
