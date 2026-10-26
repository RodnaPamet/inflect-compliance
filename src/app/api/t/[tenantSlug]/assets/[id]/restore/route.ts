import { restoreAsset } from '@/app-layer/usecases/asset';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type AssetDetailParams = { tenantSlug: string; id: string };

// Restore reverses a soft-delete. `restoreAsset` reaches `assertCanAdmin`
// through `restoreEntity`, so the route gate matches at `admin.manage` — the
// same key as the sibling purge route. While this declared `assets.edit`, an
// EDITOR passed the middleware and was refused by the usecase instead, and a
// usecase refusal writes no AUTHZ_DENIED row.
export const POST = withApiErrorHandling(requirePermission<AssetDetailParams>('admin.manage', async (_req, { params }, ctx) => {
    const { id } = await params;
    const result = await restoreAsset(ctx, id);
    return jsonResponse(result);
}));
