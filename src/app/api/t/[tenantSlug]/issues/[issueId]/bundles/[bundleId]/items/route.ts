/**
 * Items inside an evidence bundle. See the sibling `bundles/route.ts` docblock
 * for why these three routes survived the retirement of the `/issues` surface
 * and what the gate is for.
 */
import { listBundleItems, addBundleItem } from '@/app-layer/usecases/issue';
import { parseJsonBody } from '@/lib/validation/route';
import { AddBundleItemSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; issueId: string; bundleId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('tasks.view', async (_req, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const items = await listBundleItems(ctx, params.bundleId);
        return jsonResponse(items);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('tasks.edit', async (req, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const body = await parseJsonBody(req, AddBundleItemSchema);
        const item = await addBundleItem(ctx, params.bundleId, body);
        return jsonResponse(item, { status: 201 });
    }),
);
