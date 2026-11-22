/**
 * POST /api/t/:tenantSlug/risk-appetite/approve
 *
 * Approves the stored risk appetite statement and its limits (#5313 item 11,
 * owner decisions 2026-11-15). The approval names the caller and the server's
 * clock. OWNER-only: `admin.tenant_lifecycle`, which ADMIN does not hold. A
 * later save that changes the statement or a limit clears the approval.
 *
 * The body names the version the approver was shown: the configuration's id
 * and its `updatedAt` as the page loaded them (`ApproveRiskAppetiteSchema`,
 * strict; a missing or malformed marker is a 400). A save made since then is
 * a 409 `RISK_APPETITE_CHANGED_SINCE_VIEWED`, and nothing is stamped.
 *
 * The body is read with `parseJsonBody` INSIDE the permission wrapper, so
 * authorisation runs before the body is parsed.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseJsonBody } from '@/lib/validation/route';
import { ApproveRiskAppetiteSchema } from '@/app-layer/schemas/risk-appetite.schemas';
import { approveAppetiteConfig, getAppetiteApproval } from '@/app-layer/usecases/risk-appetite';

export const POST = withApiErrorHandling(
    requirePermission('admin.tenant_lifecycle', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, ApproveRiskAppetiteSchema);
        const config = await approveAppetiteConfig(ctx, body);
        const approval = await getAppetiteApproval(ctx, config);
        return jsonResponse({ success: true, approval });
    }),
);
