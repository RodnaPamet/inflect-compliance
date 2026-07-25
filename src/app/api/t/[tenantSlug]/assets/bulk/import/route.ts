import { NextRequest } from 'next/server';
import { bulkImportAssets } from '@/app-layer/usecases/asset';
import { BulkImportAssetsSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Bulk asset import — replaces the CSV importer's N sequential per-row POSTs
 * with a single request. The usecase dedupes by name and resolves free-text
 * owners to members; the response reports created / skipped / per-row errors.
 */
export const POST = withApiErrorHandling(
    requirePermission('assets.create', async (req: NextRequest, _routeArgs, ctx) => {
        const body = BulkImportAssetsSchema.parse(await req.json());
        const result = await bulkImportAssets(ctx, body.assets);
        return jsonResponse(result);
    }),
);
