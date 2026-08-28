import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { updateNode, deleteNode, aggregateByHierarchy } from '@/app-layer/usecases/risk-hierarchy';
import { parseJsonBody } from '@/lib/validation/route';
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

type NodeParams = { tenantSlug: string; nodeId: string };

/**
 * PATCH and DELETE both gate on `risks.edit`, mirroring `assertCanWrite` in
 * `updateNode` / `deleteNode`. The gate is what makes a refusal auditable: a
 * usecase assert throws 403 and records nothing, while `AUTHZ_DENIED` is
 * written by `requirePermission` and by nothing else. The asserts stay — they
 * protect non-HTTP callers.
 *
 * PATCH reads its body with `parseJsonBody` rather than composing
 * `withValidatedBody`, whose handler takes the parsed body in the third
 * argument `requirePermission` uses for `ctx`. One consequence is deliberate:
 * authorization now runs BEFORE the body is parsed, so an unauthorized caller
 * sending malformed JSON is refused rather than told its JSON is malformed.
 */
export const PATCH = withApiErrorHandling(
    requirePermission<NodeParams>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, PatchSchema);
        await updateNode(ctx, params.nodeId, body);
        return jsonResponse({ success: true });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<NodeParams>('risks.edit', async (_req, { params }, ctx) => {
        await deleteNode(ctx, params.nodeId);
        return jsonResponse({ success: true });
    }),
);
