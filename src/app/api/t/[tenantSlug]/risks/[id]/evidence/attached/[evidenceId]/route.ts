import { unlinkRiskEvidence } from '@/app-layer/usecases/risk';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; evidenceId: string };

/**
 * DELETE — detach evidence (clears the FK; evidence survives in the library).
 *
 * Gated on `risks.edit`, mirroring `assertCanWrite` in `unlinkRiskEvidence`, so
 * the refusal is auditable (#2117). Same reasoning as the `assets` twin one
 * directory over; the assert stays for non-HTTP callers.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (_req, { params }, ctx) =>
        jsonResponse(await unlinkRiskEvidence(ctx, params.id, params.evidenceId)),
    ),
);
