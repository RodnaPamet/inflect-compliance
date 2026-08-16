import { NextRequest } from 'next/server';
import { bulkDeleteAsset } from '@/app-layer/usecases/asset';
import { BulkAssetDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

// `admin.manage`, not `assets.edit`: `bulkDeleteAsset` asserts
// `assertCanAdmin`. While this declared `assets.edit`, an EDITOR passed the
// middleware and was denied by the usecase instead — and a usecase throw
// writes NO AUTHZ_DENIED row, so the very denial this gate exists to record
// was the one it missed. The sibling status/assign routes keep `assets.edit`
// because their usecases assert `assertCanWrite`.
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = BulkAssetDeleteSchema.parse(await req.json());
        const result = await bulkDeleteAsset(ctx, body.assetIds);
        return jsonResponse(result);
    }),
);
