import { getCveSyncStatus } from '@/app-layer/usecases/vulnerability';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET /api/t/:slug/vulnerabilities/status
 *
 * CVE-sync freshness + reach for the tenant: whether the NVD sync is enabled,
 * the newest CVE lastModified timestamp (global catalog), and how many of the
 * tenant's assets carry product identity for matching. Gated on
 * `assets.view`, like its sibling list read (#4465).
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('assets.view', async (_req, _routeArgs, ctx) => {
        const status = await getCveSyncStatus(ctx);
        return jsonResponse(status);
    }),
);
