import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getEvidenceBundle, addBundleItem, removeBundleItem, freezeBundle } from '@/app-layer/usecases/vendor-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const AddItemSchema = z.object({
    entityType: z.enum(['VENDOR_DOCUMENT', 'ASSESSMENT', 'EVIDENCE', 'CONTROL']),
    entityId: z.string().min(1),
}).strip();

type BundleParams = { tenantSlug: string; vendorId: string; bundleId: string };

/**
 * #2117 — both WRITE verbs gate on `vendors.edit`, and that is the strongest
 * form of "mirror the assert": `assertCanManageVendorDocs` reads
 * `ctx.appPermissions.vendors.edit` DIRECTLY, the same object and the same flag
 * `requirePermission` evaluates. So the admitted caller set is provably
 * unchanged (custom roles included) and only the recording changes — before
 * this, removing an artefact an auditor was pointed at, or freezing a bundle,
 * could be refused with nothing written anywhere, because `AUTHZ_DENIED` is
 * written by `requirePermission` and by nothing else.
 *
 * The POST is gated alongside the DELETE rather than after it: leaving it
 * ungated would make this a MIXED MODULE, where a gated DELETE certifies an
 * ungated sibling — the blind spot #2168 / #2171 had to reopen seven other
 * files to close. Freezing a bundle makes it immutable, which is not a
 * reversible edit.
 *
 * GET keeps usecase-layer authorization (`assertCanReadVendors` →
 * `vendors.view`); this issue is about destructive and write refusals.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<BundleParams> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await getEvidenceBundle(ctx, params.bundleId, params.vendorId));
});

export const POST = withApiErrorHandling(
    requirePermission<BundleParams>('vendors.edit', async (req, { params }, ctx) => {
        const url = new URL(req.url);
        if (url.searchParams.get('action') === 'freeze') {
            return jsonResponse(await freezeBundle(ctx, params.bundleId, params.vendorId));
        }
        const body = await parseJsonBody(req, AddItemSchema);
        return jsonResponse(await addBundleItem(ctx, params.bundleId, body), { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<BundleParams>('vendors.edit', async (req, { params }, ctx) => {
        const url = new URL(req.url);
        const itemId = url.searchParams.get('itemId');
        if (!itemId) return jsonResponse({ error: 'itemId required' }, { status: 400 });
        return jsonResponse(await removeBundleItem(ctx, params.bundleId, itemId));
    }),
);
