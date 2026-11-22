import { listAssetControls, mapAssetToControl } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const LinkSchema = z.object({
    controlId: z.string().min(1),
    coverageType: z.enum(['FULL', 'PARTIAL', 'UNKNOWN']).optional(),
    rationale: z.string().optional(),
}).strip();

/**
 * Reading this panel takes the ANCHOR entity's view key — the key its own
 * detail read takes — so a refusal is a 403 with an `AUTHZ_DENIED` row (#5376,
 * owner decision 2026-11-12). The usecase refuses the same anchor again and
 * omits each linked kind the caller may not view.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('assets.view', async (_req, { params }, ctx) =>
        jsonResponse(await listAssetControls(ctx, params.id)),
    ),
);

/**
 * A mapping is governed by the key of the entity you edit FROM (#4413, owner
 * decision 2026-10-27). This route hangs off the ASSET, so `assets.edit`.
 *
 * SUPERSEDES #2117 for this pair. That issue settled "the CONTROL side governs
 * a mapping where a control is one end", which is why the matching DELETE sat
 * on `controls.edit` — see its docblock. The owner's 2026-10-27 ruling replaces
 * that with the FROM entity, so both ends of this pair now ask `assets.edit`
 * and the two stop disagreeing.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        'assets.edit',
        async (req, { params }, ctx) => {
            const body = LinkSchema.parse(await req.json());
            return jsonResponse(
                await mapAssetToControl(ctx, params.id, body.controlId, body.coverageType, body.rationale),
                { status: 201 },
            );
        },
    ),
);
