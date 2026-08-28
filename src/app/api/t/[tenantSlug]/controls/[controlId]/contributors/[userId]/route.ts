import { removeContributor } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; userId: string };

/**
 * Gated on `controls.edit`, mirroring `assertCanUpdateControl` in
 * control.policies.ts — which reads the coarse `permissions.canWrite`
 * despite its control-specific name. For every built-in role the two agree
 * exactly (OWNER/ADMIN/EDITOR true, AUDITOR/READER false), so no built-in
 * role's access moves; what changes is that a custom role denying
 * `controls.edit` is now honoured, where `canWrite` ignored it.
 *
 * The gate is what makes the refusal auditable — the assert throws 403 and
 * records nothing (#2117). The usecase assert stays.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (_req, { params }, ctx) => {
        await removeContributor(ctx, params.controlId, params.userId);
        return jsonResponse({ success: true });
    }),
);
