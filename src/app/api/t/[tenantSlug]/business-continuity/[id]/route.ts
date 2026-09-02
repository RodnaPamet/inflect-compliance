import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getBia, updateBia, deleteBia, UpdateBiaSchema } from '@/app-layer/usecases/business-impact-analysis';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Ctx = { params: Promise<{ tenantSlug: string; id: string }> };
type Params = { tenantSlug: string; id: string };

/**
 * GET/PUT/DELETE a single Business Impact Analysis.
 *
 * PUT and DELETE carry the Epic C.1 gate (#2197). They authorized correctly
 * before it, via `assertCanWrite` in the usecase — but a usecase assert throws
 * a 403 and writes NOTHING, while `AUTHZ_DENIED` is written by
 * `requirePermission` and by nothing else. So a refused attempt to erase a
 * whole Business Impact Analysis left no trace at all.
 *
 * `continuity.edit` mirrors that assert rather than out-stricting it: the flag
 * is TRUE for exactly OWNER / ADMIN / EDITOR, which is
 * `computePermissions(...).canWrite`. GET stays on `assertCanRead` — there is
 * no `continuity.view` to gate it on, deliberately.
 *
 * ═══ WHY parseJsonBody AND NOT withValidatedBody ═══
 *
 * `withValidatedBody` hands the body as the THIRD argument, which is the slot
 * `requirePermission` already uses for the resolved `RequestContext`. Composing
 * them silently passes the route args where the ctx belongs. `parseJsonBody`
 * has identical parse semantics and reads inline.
 *
 * That reorders one observable response. A malformed JSON body used to be
 * rejected 400 before any authorization ran; the gate now runs first, so an
 * under-privileged caller sending garbage gets 403 rather than 400. Refusing
 * before parsing an unauthorized caller's payload is the better order, and it
 * matches the 58 routes that already pair the two.
 */
export const GET = withApiErrorHandling(async (req: NextRequest, { params: p }: Ctx) => {
    const params = await p;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await getBia(ctx, params.id));
});

export const PUT = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, UpdateBiaSchema);
        return jsonResponse(await updateBia(ctx, params.id, body));
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (_req, { params }, ctx) => {
        return jsonResponse(await deleteBia(ctx, params.id));
    }),
);
