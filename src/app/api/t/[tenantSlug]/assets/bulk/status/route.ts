import { NextRequest } from 'next/server';
import { bulkSetAssetStatus } from '@/app-layer/usecases/asset';
import { BulkAssetStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission('assets.edit', async (req: NextRequest, _routeArgs, ctx) => {
        const body = BulkAssetStatusSchema.parse(await req.json());
        const result = await bulkSetAssetStatus(ctx, body.assetIds, body.status);
        return jsonResponse(result);
    }),
);
