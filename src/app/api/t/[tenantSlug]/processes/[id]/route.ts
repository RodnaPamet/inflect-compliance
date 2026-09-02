import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import {
    getProcessMap,
    saveProcessMap,
    setProcessMapCanvasMode,
    setProcessMapStatus,
    deleteProcessMap,
} from '@/app-layer/usecases/process-map';
import { parseJsonBody } from '@/lib/validation/route';
import { SaveProcessMapSchema } from '@/app-layer/schemas/process-map';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** PATCH — metadata-only switch (no graph save): canvas mode OR lifecycle
 *  status. Exactly one field is acted on per request (canvasMode wins if both
 *  are somehow sent). */
const PatchProcessMapSchema = z
    .object({
        canvasMode: z.enum(['DOCUMENT', 'AUTOMATION']).optional(),
        status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
    })
    .refine((v) => v.canvasMode !== undefined || v.status !== undefined, {
        message: 'One of canvasMode or status is required',
    });

type Params = { tenantSlug: string; id: string };

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const map = await getProcessMap(ctx, params.id);
        return jsonResponse(map);
    },
);

/**
 * PUT / PATCH — save the graph, or flip canvas mode / lifecycle status.
 *
 * All three usecases behind these two verbs assert `assertCanWrite`, and
 * `processes.edit` is defined to be TRUE for exactly the roles that predicate
 * admits (OWNER / ADMIN / EDITOR). So the gate changes who is REFUSED for no
 * session-backed caller; what it changes is that the refusal now writes an
 * `AUTHZ_DENIED` row, which a usecase assert never did.
 *
 * The `processes` domain did not exist when the DELETE below was gated, and
 * this file recorded the two ways of gating these verbs that were available
 * then — reuse `admin.manage` (out-stricts the assert, locking out every
 * EDITOR) or invent a key (an authorization-model change belonging in its own
 * reviewed diff). #2197 is that diff: it added `continuity` and `processes` to
 * `PermissionSet`, so the third option exists now and these verbs take it.
 *
 * Body parsing moved to `parseJsonBody` because `withValidatedBody` hands the
 * body in the same argument slot `requirePermission` uses for the ctx. One
 * observable consequence: a malformed body from an under-privileged caller now
 * answers 403 rather than 400, because the gate runs before the parse.
 */
export const PUT = withApiErrorHandling(
    requirePermission<Params>('processes.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, SaveProcessMapSchema);
        const map = await saveProcessMap(ctx, params.id, body);
        return jsonResponse(map);
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('processes.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, PatchProcessMapSchema);
        const result = body.canvasMode
            ? await setProcessMapCanvasMode(ctx, params.id, body.canvasMode)
            : await setProcessMapStatus(ctx, params.id, body.status!);
        return jsonResponse(result);
    }),
);

/**
 * DELETE — the one verb in this file whose gate is NOT `processes.edit`.
 *
 * `deleteProcessMap` asserts `assertCanAdmin`, so the refusal was already
 * correct. It was also unrecorded: a usecase assert throws a 403 and writes
 * nothing, while `AUTHZ_DENIED` is written by `requirePermission` and by
 * nothing else. That matters more here than on any other register — ProcessMap
 * is in NEITHER `SOFT_DELETE_MODELS` nor the `SoftDeletableModel` union, so
 * there is no restore surface for any role, and both reverse-lookup queries
 * filter deleted maps, meaning a delete quietly drops control-coverage
 * placements out of the governance view. An attempt at that, refused, is
 * precisely the event worth having on the record.
 *
 * `admin.manage` mirrors `assertCanAdmin` in the same one-directional way the
 * migrated purge routes do: the assert reads role-derived
 * `ctx.permissions.canAdmin`, the middleware the custom-role-aware
 * `ctx.appPermissions.admin.manage`, and they diverge only for a custom role
 * that explicitly set `admin.manage: false` on an ADMIN/OWNER base — now
 * refused rather than admitted, which is what that role asked for.
 *
 * Deliberately NOT `processes.edit`: that flag sits at the canWrite tier, and
 * using it here would hand every EDITOR an unrecoverable delete.
 *
 * ═══ NO ROUTE_PERMISSIONS / PRIVILEGED_ROOTS ENTRY, DELIBERATELY ═══
 *
 * Registering the route would put the WHOLE FILE in the coverage guardrail's
 * population, and the guardrail is satisfied by `requirePermission` appearing
 * anywhere in a file. The GET here still authorizes through `getTenantCtx` +
 * `assertCanRead`, and no `PermissionSet` key mirrors that predicate — there is
 * deliberately no `processes.view`. A registry entry would therefore assert
 * coverage this file has not earned. The gates below and above write their
 * audit rows regardless — registration is a CI-visibility question, not an
 * enforcement one. Same shape, and the same reasoning, as
 * `calendar/connections/route.ts`.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.manage',
        async (_req, { params }, ctx) => {
            const result = await deleteProcessMap(ctx, params.id);
            return jsonResponse(result);
        },
    ),
);
