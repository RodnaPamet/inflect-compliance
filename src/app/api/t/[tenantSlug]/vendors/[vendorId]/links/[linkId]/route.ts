import { removeVendorLink } from '@/app-layer/usecases/vendor';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * DELETE a vendor link — the association between a vendor and the control,
 * risk or asset it bears on. Detaching one removes the vendor from the
 * "where is this used?" traceability view without deleting either side.
 *
 * Gated at the Epic C.1 layer as well as in the usecase (#2117), for the
 * reason set out in the sibling `documents/[docId]` route: the usecase
 * refusal is correct and writes nothing, so the denial this route exists to
 * make was unrecorded.
 *
 * `vendors.edit` mirrors `assertCanManageVendors` exactly — that assert reads
 * `ctx.appPermissions.vendors.edit`, the same flag the middleware checks — so
 * this is a move of the recording layer, not of the policy. The usecase
 * assert stays as the guard for non-HTTP callers.
 */
type Params = { tenantSlug: string; vendorId: string; linkId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (_req, { params }, ctx) => {
        await removeVendorLink(ctx, params.linkId, params.vendorId);
        return jsonResponse({ deleted: true });
    }),
);
