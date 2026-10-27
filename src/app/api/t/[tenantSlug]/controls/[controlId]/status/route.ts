import { setControlStatus } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { SetControlStatusSchema } from '@/lib/schemas';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * The route gate mirrors the usecase's own (#4387).
 *
 * `setControlStatus` asserts `assertCanUpdateControl` (`canWrite` + `controls.edit`), and this route carried no
 * `requirePermission` at all — so the refusal happened inside the usecase and
 * wrote no `AUTHZ_DENIED` row. No role gains or loses anything here: the key is
 * the one the usecase already asks for. What changes is that a denial is now
 * audited, and happens before the handler runs.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, SetControlStatusSchema);
        return jsonResponse(await setControlStatus(ctx, params.controlId, body.status));
    }),
);
