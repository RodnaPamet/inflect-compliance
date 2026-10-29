import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssetRisks, mapAssetToRisk } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const LinkSchema = z.object({
    riskId: z.string().min(1),
    exposureLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    rationale: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await listAssetRisks(ctx, params.id));
});

/**
 * A mapping is governed by the key of the entity you edit FROM (#4413, owner
 * decision 2026-10-27). This route hangs off the ASSET, so `assets.edit`.
 *
 * It had no gate at all, so a refusal wrote no `AUTHZ_DENIED` row — and the
 * usecase behind it checked a role NAME, which a custom role bypassed
 * entirely. Its sibling `DELETE /risks/:riskId` already required this key.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        'assets.edit',
        async (req, { params }, ctx) => {
            const body = LinkSchema.parse(await req.json());
            return jsonResponse(
                await mapAssetToRisk(ctx, params.id, body.riskId, body.exposureLevel, body.rationale),
                { status: 201 },
            );
        },
    ),
);
