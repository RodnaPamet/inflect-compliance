/**
 * POST /api/t/[tenantSlug]/evidence/[id]/retention
 * Set retention dates on evidence.
 * Body: { retentionUntil?, retentionPolicy?, retentionDays? }
 *
 * Gated on `evidence.edit`, like the archive route and every other evidence
 * edit. A retention date decides when the sweep archives the record, so
 * setting one is an edit of the record. The gate reads `appPermissions`, which
 * honours custom-role overrides, and a refusal writes an `AUTHZ_DENIED` row.
 * The usecase asserts the same key for non-HTTP callers.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { updateEvidenceRetention } from '@/app-layer/usecases/evidence-retention';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

const RetentionSchema = z.object({
    retentionUntil: z.string().datetime().nullable().optional(),
    retentionPolicy: z.enum(['NONE', 'FIXED_DATE', 'DAYS_AFTER_UPLOAD']).optional(),
    retentionDays: z.number().int().min(1).max(36500).nullable().optional(),
}).strip();

export const POST = withApiErrorHandling(
    requirePermission<Params>('evidence.edit', async (req, { params }, ctx) => {
        const body = RetentionSchema.parse(await req.json());
        const result = await updateEvidenceRetention(ctx, params.id, body);
        return jsonResponse(result);
    }),
);
