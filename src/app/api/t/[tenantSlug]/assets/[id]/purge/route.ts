import { purgeAsset } from '@/app-layer/usecases/asset';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type AssetDetailParams = { tenantSlug: string; id: string };

// Purge is an IRREVERSIBLE hard delete — the usecase asserts canAdmin, so the
// route gate must match at the admin level (not the `assets.edit` a mere
// EDITOR holds) or an EDITOR is denied by the usecase AFTER passing the route
// gate, and the denial never audits at the permission layer. `admin.manage`
// mirrors assertCanAdmin (OWNER/ADMIN).
export const POST = withApiErrorHandling(requirePermission<AssetDetailParams>('admin.manage', async (_req, { params }, ctx) => {
    const { id } = await params;
    const result = await purgeAsset(ctx, id);
    return jsonResponse(result);
}));
