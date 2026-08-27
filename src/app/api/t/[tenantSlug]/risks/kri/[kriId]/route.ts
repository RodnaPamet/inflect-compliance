import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { updateKri, deleteKri } from '@/app-layer/usecases/key-risk-indicator';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-6 — single KRI: PATCH update, DELETE. */
const PatchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    unit: z.string().max(20).nullable().optional(),
    direction: z.enum(['HIGHER_IS_WORSE', 'LOWER_IS_WORSE']).optional(),
    greenMax: z.number().nullable().optional(),
    amberMax: z.number().nullable().optional(),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY']).optional(),
    ownerUserId: z.string().nullable().optional(),
    targetValue: z.number().nullable().optional(),
    isActive: z.boolean().optional(),
});

export const PATCH = withApiErrorHandling(
    withValidatedBody(PatchSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; kriId: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await updateKri(ctx, params.kriId, body);
        return jsonResponse({ success: true });
    }),
);

type DeleteParams = { tenantSlug: string; kriId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<DeleteParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteKri(ctx, params.kriId);
        return jsonResponse({ success: true });
    }),
);
