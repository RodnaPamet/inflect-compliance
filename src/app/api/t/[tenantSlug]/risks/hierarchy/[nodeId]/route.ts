import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { updateNode, deleteNode, aggregateByHierarchy } from '@/app-layer/usecases/risk-hierarchy';
import { withValidatedBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-5 — single node: GET aggregation, PATCH update, DELETE (cascades links). */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; nodeId: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse({ aggregation: await aggregateByHierarchy(ctx, params.nodeId) });
    },
);

const PatchSchema = z.object({ name: z.string().min(1).max(200).optional(), parentId: z.string().nullable().optional(), sortOrder: z.number().int().optional() });

export const PATCH = withApiErrorHandling(
    withValidatedBody(PatchSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; nodeId: string }> }, body) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await updateNode(ctx, params.nodeId, body);
        return jsonResponse({ success: true });
    }),
);

type DeleteParams = { tenantSlug: string; nodeId: string };

/**
 * Gated on `risks.edit`, mirroring `deleteNode`'s `assertCanWrite`.
 *
 * PATCH is deliberately NOT migrated in this diff: it composes through
 * `withValidatedBody`, and stacking that with `requirePermission` is a
 * different question from the one #2117 asks (which is whether a REFUSAL is
 * auditable). Destructive verbs first; the validated-body composition is its
 * own change, with its own test.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<DeleteParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteNode(ctx, params.nodeId);
        return jsonResponse({ success: true });
    }),
);
