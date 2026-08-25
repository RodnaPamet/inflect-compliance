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
import { withValidatedBody } from '@/lib/validation/route';
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

export const PUT = withApiErrorHandling(
    withValidatedBody(
        SaveProcessMapSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const map = await saveProcessMap(ctx, params.id, body);
            return jsonResponse(map);
        },
    ),
);

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        PatchProcessMapSchema,
        async (
            req,
            { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> },
            body,
        ) => {
            const params = await paramsPromise;
            const ctx = await getTenantCtx(params, req);
            const result = body.canvasMode
                ? await setProcessMapCanvasMode(ctx, params.id, body.canvasMode)
                : await setProcessMapStatus(ctx, params.id, body.status!);
            return jsonResponse(result);
        },
    ),
);

/**
 * DELETE — the one verb in this file that is destructive, and the only one
 * gated at the Epic C.1 layer (#2117).
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
 * ═══ NO ROUTE_PERMISSIONS / PRIVILEGED_ROOTS ENTRY, DELIBERATELY ═══
 *
 * Registering the route would put the WHOLE FILE in the coverage guardrail's
 * population, and the guardrail is satisfied by `requirePermission` appearing
 * anywhere in a file. GET / PUT / PATCH here still authorize through
 * `getTenantCtx` + a usecase assert; they were not triaged in this tranche
 * and are not destructive. A registry entry would therefore assert coverage
 * this diff did not earn. The gate below writes the audit row regardless —
 * registration is a CI-visibility question, not an enforcement one. Same
 * shape, and the same reasoning, as `calendar/connections/route.ts`.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; id: string }>(
        'admin.manage',
        async (_req, { params }, ctx) => {
            const result = await deleteProcessMap(ctx, params.id);
            return jsonResponse(result);
        },
    ),
);
