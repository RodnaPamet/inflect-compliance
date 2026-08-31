import { unlinkAssetEvidence } from '@/app-layer/usecases/asset';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; evidenceId: string };

/**
 * DELETE — detach evidence (clears the FK; evidence survives in the library).
 *
 * Gated on `assets.edit`, mirroring `assertCanWrite` in `unlinkAssetEvidence`.
 * The gate is what makes a refusal auditable: a usecase assert throws 403 and
 * records nothing, while `AUTHZ_DENIED` is written by `requirePermission` and
 * by nothing else (#2117). The assert stays — it protects non-HTTP callers.
 *
 * `assets.edit` is true for exactly OWNER / ADMIN / EDITOR, which is exactly
 * `canWrite` (`level >= 3` in `computePermissions`), so the built-in caller set
 * is unchanged. For a CUSTOM role the two can diverge, and only in the safe
 * direction: `ctx.permissions` is computed from the built-in role alone while
 * `appPermissions` is custom-role aware, so a tenant that revoked `assets.edit`
 * gets an audited refusal here rather than a write. The assert cannot admit
 * anyone this gate turned away, so the pair is fail-closed by construction.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (_req, { params }, ctx) =>
        jsonResponse(await unlinkAssetEvidence(ctx, params.id, params.evidenceId)),
    ),
);
