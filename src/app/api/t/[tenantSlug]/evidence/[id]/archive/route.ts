/**
 * POST /api/t/[tenantSlug]/evidence/[id]/archive — archive evidence.
 *
 * Gated on `evidence.edit`, mirroring `archiveEvidence`'s `assertCanWrite`.
 * The gate is what makes a refusal auditable: `assertCanWrite` throws 403 and
 * writes nothing, so a denied archive attempt left no trace (#2117). It also
 * reads `appPermissions`, which honours custom-role overrides — `canWrite` is
 * computed from the built-in role tier alone and ignores them.
 *
 * The usecase assert stays; it protects non-HTTP callers.
 */
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { archiveEvidence } from '@/app-layer/usecases/evidence-retention';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('evidence.edit', async (_req, { params }, ctx) => {
        const result = await archiveEvidence(ctx, params.id);
        return jsonResponse(result);
    }),
);
