import { z } from 'zod';
import { listVulnerabilities, linkCveToAsset } from '@/app-layer/usecases/vulnerability';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

/**
 * Route gates on the asset keys (#4465).
 *
 * A matched vulnerability is an asset-domain record (`AssetVulnerability`), so
 * it is read under `assets.view` and written under `assets.edit` — the keys the
 * `/assets` routes already ask. Before #4465 these routes asked nothing and the
 * usecase's coarse `assertCanRead` / `assertCanWrite` refused alone, writing no
 * `AUTHZ_DENIED` row. Built-in roles are unchanged: `assets.view` is held by
 * every role and `assets.edit` by exactly the roles with `canWrite`.
 */
export const GET = withApiErrorHandling(
    requirePermission<Params>('assets.view', async (req, _routeArgs, ctx) => {
        const sp = req.nextUrl.searchParams;
        const rows = await listVulnerabilities(ctx, {
            severity: sp.get('severity') ?? undefined,
            status: sp.get('status') ?? undefined,
            assetId: sp.get('assetId') ?? undefined,
        });
        return jsonResponse({ rows });
    }),
);

const LinkSchema = z.object({
    assetId: z.string().min(1),
    cveId: z.string().min(1),
    note: z.string().max(20_000).optional().nullable(),
});

export const POST = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, LinkSchema);
        const link = await linkCveToAsset(ctx, body);
        return jsonResponse(link, { status: 201 });
    }),
);
