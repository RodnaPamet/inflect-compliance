import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    listProcessMaps,
    createProcessMap,
} from '@/app-layer/usecases/process-map';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateProcessMapSchema } from '@/app-layer/schemas/process-map';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * GET  — list process maps (assertCanRead; every role holds it).
 * POST — create one. Gated on `processes.edit` (#2197), which mirrors the
 *        `assertCanWrite` in `createProcessMap`, so the caller set is
 *        unchanged and a refusal now writes an AUTHZ_DENIED row.
 *
 * No `ROUTE_PERMISSIONS` / `PRIVILEGED_ROOTS` entry, for the reason the
 * sibling `[id]/route.ts` records at length: registering the file would claim
 * coverage over its ungated GET, and the gate writes the audit row either way.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const maps = await listProcessMaps(ctx);
        return jsonResponse(maps);
    },
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('processes.edit', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, CreateProcessMapSchema);
        const map = await createProcessMap(ctx, body);
        return jsonResponse(map, { status: 201 });
    }),
);
