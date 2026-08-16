import { NextRequest } from 'next/server';
import { bulkDeleteRisk } from '@/app-layer/usecases/risk';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkRiskDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

// `admin.manage` matches the tier `bulkDeleteRisk` itself asserts. That alignment is
// the point of the gate: if the declared key were the weaker one, the
// middleware would let the request through and the usecase would throw —
// and a usecase throw writes NO AUTHZ_DENIED row, so the denial would be
// invisible to the security trail. See docs/epic-c-security.md (C.1).
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkRiskDeleteSchema);
        const result = await bulkDeleteRisk(ctx, body.riskIds);
        return jsonResponse(result);
    }),
);
