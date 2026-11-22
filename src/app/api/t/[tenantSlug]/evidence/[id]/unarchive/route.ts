/**
 * POST /api/t/[tenantSlug]/evidence/[id]/unarchive — unarchive evidence.
 *
 * Gated on `evidence.edit`, the same key as its archive twin. Unarchiving also
 * clears a lapsed retention date and policy, so it undoes what an edit set.
 * The gate reads `appPermissions`, which honours custom-role overrides, and a
 * refusal writes an `AUTHZ_DENIED` row. The usecase asserts the same key for
 * non-HTTP callers.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { unarchiveEvidence } from '@/app-layer/usecases/evidence-retention';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('evidence.edit', async (_req, { params }, ctx) => {
        const result = await unarchiveEvidence(ctx, params.id);
        return jsonResponse(result);
    }),
);
