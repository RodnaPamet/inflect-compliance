/**
 * Freeze an evidence bundle. See the sibling `bundles/route.ts` docblock for
 * why these three routes survived the retirement of the `/issues` surface.
 *
 * Freezing is a write that makes a bundle immutable, so it is gated on
 * `tasks.edit` like the other mutations here — not on `tasks.view`.
 */
import { freezeBundle } from '@/app-layer/usecases/issue';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; issueId: string; bundleId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('tasks.edit', async (_req, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const bundle = await freezeBundle(ctx, params.bundleId);
        return jsonResponse(bundle);
    }),
);
