import { removeVendorDocument } from '@/app-layer/usecases/vendor';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * DELETE a vendor document — the due-diligence artefact (SOC 2 report, DPA,
 * pen-test letter) a vendor assessment was signed off against.
 *
 * Gated at the Epic C.1 layer as well as in the usecase (#2117). The refusal
 * was always correct: `removeVendorDocument` calls `assertCanManageVendorDocs`.
 * It was also INVISIBLE — `AUTHZ_DENIED` is written by `requirePermission` and
 * by nothing else, so a turned-away attempt to strip a vendor's evidence left
 * a 403 in the request log and silence in the audit trail.
 *
 * `vendors.edit` is not a judgement call here: `assertCanManageVendorDocs`
 * reads `ctx.appPermissions.vendors.edit`, which is the EXACT predicate
 * `requirePermission('vendors.edit', …)` evaluates. Same object, same flag —
 * so the set of callers who succeed is unchanged and only the layer that
 * records the refusal moves. The usecase assert stays: it is what protects
 * the non-HTTP callers (jobs, scripts) that never pass through this file.
 */
type Params = { tenantSlug: string; vendorId: string; docId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (_req, { params }, ctx) => {
        await removeVendorDocument(ctx, params.docId, params.vendorId);
        return jsonResponse({ deleted: true });
    }),
);
