import { z } from 'zod';
import { updateKri, deleteKri } from '@/app-layer/usecases/key-risk-indicator';
import { parseJsonBody } from '@/lib/validation/route';
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

type KriParams = { tenantSlug: string; kriId: string };

/**
 * PATCH and DELETE both gate on `risks.edit`, mirroring `assertCanWrite` in
 * `updateKri` / `deleteKri`. The gate is what makes a refusal auditable: a
 * usecase assert throws 403 and records nothing, while `AUTHZ_DENIED` is
 * written by `requirePermission` and by nothing else. The asserts stay — they
 * protect non-HTTP callers.
 *
 * PATCH reads its body with `parseJsonBody` rather than composing
 * `withValidatedBody`, whose handler takes the parsed body in the third
 * argument `requirePermission` uses for `ctx`. Authorization therefore runs
 * BEFORE the body is parsed, which is the order we want.
 */
export const PATCH = withApiErrorHandling(
    requirePermission<KriParams>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, PatchSchema);
        await updateKri(ctx, params.kriId, body);
        return jsonResponse({ success: true });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<KriParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteKri(ctx, params.kriId);
        return jsonResponse({ success: true });
    }),
);
