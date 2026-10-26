/**
 * Epic 46.4 — Framework reorder endpoint.
 *
 * POST /api/t/[tenantSlug]/frameworks/[frameworkKey]/reorder
 *
 * Body: `{ sections: [{ sectionId, requirementIds: string[] }, ...] }`
 *
 * Persists a per-tenant `sortOrder` overlay for every
 * non-deprecated requirement in the framework. Gated by
 * `assertCanInstallFrameworkPack` inside the usecase (the
 * `frameworks.install` permission every other tenant-scoped
 * framework write uses).
 *
 * Why a path-level new route instead of an `?action=reorder` on
 * the existing handler: matches the `/tree` sibling route's
 * shape, keeps Zod validation isolated, and gives the
 * permission-coverage guardrail a single file to point at if the
 * frameworks subtree ever moves into the privileged-roots list.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { reorderFrameworkRequirements } from '@/app-layer/usecases/framework';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const ReorderSchema = z
    .object({
        sections: z
            .array(
                z.object({
                    sectionId: z.string().min(1),
                    requirementIds: z.array(z.string().min(1)),
                }),
            )
            .min(1)
            .max(500),
    })
    .strip();

export const POST = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; frameworkKey: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const raw = await req.json();
        const body = ReorderSchema.parse(raw);
        const result = await reorderFrameworkRequirements(
            ctx,
            params.frameworkKey,
            body.sections,
        );
        return jsonResponse(result, { status: 200 });
    },
);
