/**
 * POST /api/t/[tenantSlug]/evidence/[id]/controls
 * EP-3 — link an existing evidence record to a control (creates one
 * EvidenceControlLink). Idempotent on the (evidence, control) pair.
 */
import { getTenantCtx } from '@/app-layer/context';
import { linkEvidenceToControl } from '@/app-layer/usecases/evidence';
import { withValidatedBody } from '@/lib/validation/route';
import { LinkEvidenceControlSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(withValidatedBody(LinkEvidenceControlSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await linkEvidenceToControl(ctx, params.id, body.controlId);
    return jsonResponse({ success: true, ...result });
}));
