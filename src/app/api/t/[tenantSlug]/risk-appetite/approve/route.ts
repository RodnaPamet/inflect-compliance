/**
 * POST /api/t/:tenantSlug/risk-appetite/approve
 *
 * Approves the stored risk appetite statement and its limits, as they stand
 * (#5313 item 11, owner decisions 2026-11-15). The approval names the caller
 * and the server's clock; the request carries no body. OWNER-only:
 * `admin.tenant_lifecycle`, which ADMIN does not hold. A later save that
 * changes the statement or a limit clears the approval.
 */
import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { approveAppetiteConfig, getAppetiteApproval } from '@/app-layer/usecases/risk-appetite';

export const POST = withApiErrorHandling(
    requirePermission('admin.tenant_lifecycle', async (_req: NextRequest, _routeArgs, ctx) => {
        const config = await approveAppetiteConfig(ctx);
        const approval = await getAppetiteApproval(ctx, config);
        return jsonResponse({ success: true, approval });
    }),
);
