import { NextRequest } from 'next/server';
import { bulkDeleteAsset } from '@/app-layer/usecases/asset';
import { BulkAssetDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission('assets.edit', async (req: NextRequest, _routeArgs, ctx) => {
        const body = BulkAssetDeleteSchema.parse(await req.json());
        const result = await bulkDeleteAsset(ctx, body.assetIds);
        return jsonResponse(result);
    }),
);
