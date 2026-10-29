import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
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

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await listAssetControls(ctx, params.id));
});

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
