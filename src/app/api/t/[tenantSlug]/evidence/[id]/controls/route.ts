/**
 * POST /api/t/[tenantSlug]/evidence/[id]/controls
 * EP-3 — link an existing evidence record to a control (creates one
 * EvidenceControlLink). Idempotent on the (evidence, control) pair.
 */
import { NextRequest } from 'next/server';
import { linkEvidenceToControl } from '@/app-layer/usecases/evidence';
import { parseJsonBody } from '@/lib/validation/route';
import { LinkEvidenceControlSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Gated on `controls.edit`, the same key as the unlink route beside it
 * (`[controlId]/route.ts`): the CONTROL side governs a mapping where a control
 * is one end, so making the link and removing it take one key (#4326, owner
 * decision). Before this the route asked only the usecase's coarse
 * `assertCanWrite`, so an EDITOR-based custom role without `controls.edit`
 * could link a control it could not unlink, and a refusal wrote no
 * AUTHZ_DENIED row.
 *
 * `controls.edit` matches the coarse write tier for every built-in role, so no
 * built-in role loses access. The usecase assert stays, as it does for unlink.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req: NextRequest, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkEvidenceControlSchema);
        const result = await linkEvidenceToControl(ctx, params.id, body.controlId);
        return jsonResponse({ success: true, ...result });
    }),
);
