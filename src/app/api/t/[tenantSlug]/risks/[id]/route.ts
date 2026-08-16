import { getRisk, updateRisk, deleteRisk } from '@/app-layer/usecases/risk';
import { UpdateRiskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type RiskDetailParams = { tenantSlug: string; id: string };

export const GET = withApiErrorHandling(requirePermission<RiskDetailParams>('risks.view', async (_req, { params }, ctx) => {
    const { id } = await params;
    const risk = await getRisk(ctx, id);
    return jsonResponse(risk);
}));

export const PUT = withApiErrorHandling(requirePermission<RiskDetailParams>('risks.edit', async (req, { params }, ctx) => {
    const { id } = await params;
    const body = await parseJsonBody(req, UpdateRiskSchema);
    const risk = await updateRisk(ctx, id, body);
    return jsonResponse({ success: true, risk });
}));

// `admin.manage`, not `risks.edit`: `deleteRisk` asserts `assertCanAdmin`.
// The weaker key let an EDITOR past the middleware to be denied by the
// usecase, which writes no AUTHZ_DENIED row — the denial was invisible.
export const DELETE = withApiErrorHandling(requirePermission<RiskDetailParams>('admin.manage', async (_req, { params }, ctx) => {
    const { id } = await params;
    await deleteRisk(ctx, id);
    return jsonResponse({ success: true });
}));
