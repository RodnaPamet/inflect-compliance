import { z } from 'zod';
import { linkBiaToControl } from '@/app-layer/usecases/business-impact-analysis';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

const LinkSchema = z.object({ controlId: z.string().min(1) });

type Params = { tenantSlug: string; id: string };

/**
 * POST — attach this BIA to a control as evidence (kind BIA).
 *
 * Gated on `continuity.edit` (#2197). This is the edge that makes a control
 * read as satisfying NIS2 Art.21(2)(c) in the coverage view, so an attempt to
 * create one that was refused is worth having on the record.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkSchema);
        return jsonResponse(await linkBiaToControl(ctx, params.id, body.controlId), { status: 201 });
    }),
);
