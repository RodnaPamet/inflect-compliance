import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getControlEvidenceTab, linkEvidence } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { LinkEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

// GET — combined Evidence-tab payload (#102 item 1): `{ links, evidence }`.
// The evidence-link list and the directly-attached Evidence entities
// both used to ride on the eager control page-data payload.
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const data = await getControlEvidenceTab(ctx, params.controlId);
    return jsonResponse(data);
});

/**
 * Attach evidence to the control: a web link (`kind: 'LINK'`, `url`, `note`),
 * an uploaded file (`kind: 'FILE'`, `fileId`, `note`) or an integration result.
 *
 * Gated on `controls.edit`, the key of the unlink route beside it
 * (`[linkId]/route.ts`) and of the evidence side's link route
 * (`/evidence/[id]/controls`). `linkEvidence` already asserts
 * `assertCanLinkEvidence` (the coarse write tier AND `controls.edit`), so no
 * role gains or loses anything; the gate makes a refusal write a hash-chained
 * AUTHZ_DENIED row, which the usecase's throw does not (#4326, owner
 * decision). The usecase assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req: NextRequest, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkEvidenceSchema);
        const link = await linkEvidence(ctx, params.controlId, body);
        return jsonResponse(link, { status: 201 });
    }),
);
