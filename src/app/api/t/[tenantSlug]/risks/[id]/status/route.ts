import { updateRisk } from '@/app-layer/usecases/risk';
import { parseJsonBody } from '@/lib/validation/route';
import { SetRiskStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type RiskParams = { tenantSlug: string; id: string };

// `risks.edit`, like PUT /risks/:id: changing a risk's status is an edit of
// the risk, and a custom role that withholds the key must be refused here too.
export const PATCH = withApiErrorHandling(requirePermission<RiskParams>('risks.edit', async (req, { params }, ctx) => {
    const body = await parseJsonBody(req, SetRiskStatusSchema);
    const risk = await updateRisk(ctx, params.id, { status: body.status });
    return jsonResponse(risk);
}));
