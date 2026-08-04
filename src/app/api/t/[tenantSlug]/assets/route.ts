import { listAssets, listAssetsPaginated, createAsset, listAssetsWithDeleted } from '@/app-layer/usecases/asset';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateAssetSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const AssetQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    criticality: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

export const GET = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('assets.view', async (req, _routeArgs, ctx) => {
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = AssetQuerySchema.parse(sp);

    if (query.includeDeleted === 'true') {
        // Honour the same toolbar filters the client keeps active in deleted mode.
        const assets = await listAssetsWithDeleted(ctx, {
            type: query.type,
            status: query.status,
            criticality: query.criticality,
            q: query.q,
        });
        return jsonResponse(assets);
    }

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listAssetsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: {
                type: query.type,
                status: query.status,
                criticality: query.criticality,
                q: query.q,
            },
        });
        return jsonResponse(result);
    }

    // Backfill cap — ask for cap+1 rows so the helper can tell a full page
    // from an overflowing one, and report `truncated` to the client.
    //
    // This used to return a BARE ARRAY with a "backward compat" note. The
    // array was silently clipped at the repository's internal cap, so a
    // tenant over the limit saw a short list and — worse — KPI counts
    // computed over it, with nothing on screen saying so. Every sibling
    // list route already returns `{ rows, truncated }`.
    const assets = await listAssets(
        ctx,
        {
            type: query.type,
            status: query.status,
            criticality: query.criticality,
            q: query.q,
        },
        { take: LIST_BACKFILL_CAP + 1 },
    );
    const result = applyBackfillCap(assets);
    recordListPageRowCount({
        entity: 'assets',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
}));

export const POST = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('assets.create', async (req, _routeArgs, ctx) => {
    const body = await parseJsonBody(req, CreateAssetSchema);
    const asset = await createAsset(ctx, body);
    return jsonResponse(asset, { status: 201 });
}));
