import { NextRequest } from 'next/server';
import { bulkAssignAsset } from '@/app-layer/usecases/asset';
import { BulkAssetAssignSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission('assets.edit', async (req: NextRequest, _routeArgs, ctx) => {
        const body = BulkAssetAssignSchema.parse(await req.json());
        const result = await bulkAssignAsset(ctx, body.assetIds, body.ownerUserId);
        return jsonResponse(result);
    }),
);
