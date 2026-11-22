import { linkControlToRisk } from '@/app-layer/usecases/risk';
import { parseJsonBody } from '@/lib/validation/route';
import { LinkRiskControlSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

// Map a control to a risk. `controls.edit`, the key its twin
// POST /controls/:controlId/risks takes: both write the same mapping.
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkRiskControlSchema);
        const rc = await linkControlToRisk(ctx, params.id, body.controlId);
        return jsonResponse(rc, { status: 201 });
    }),
);
