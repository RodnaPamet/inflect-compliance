import { z } from 'zod';
import { linkRisk, unlinkRisk } from '@/app-layer/usecases/risk-hierarchy';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-5 — link/unlink a risk to/from a hierarchy node. */
const Body = z.object({ riskId: z.string().min(1) });

type Params = { tenantSlug: string; nodeId: string };

/**
 * Both verbs gate on `risks.edit`, mirroring `assertCanWrite` in `linkRisk` /
 * `unlinkRisk`, so a refusal is auditable (#2117). The asserts stay — they
 * protect non-HTTP callers.
 *
 * This matches the node route one directory up, which has gated its PATCH and
 * DELETE on `risks.edit` since the second #2117 tranche. The links route was
 * left behind because it composed `withValidatedBody`; that reason has
 * evaporated now that `parseJsonBody` is the documented way through, and the
 * split was worth closing — `deleteNode` cascades its links, so the gated
 * sibling already audited the wholesale removal while the ungated one here
 * detached them individually.
 *
 * The POST is included because it is a mutating verb in the same module and
 * leaving it on the old path would recreate the mixed-module blind spot the
 * census warns about, not because linking is itself destructive.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, Body);
        await linkRisk(ctx, body.riskId, params.nodeId);
        return jsonResponse({ success: true });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, Body);
        await unlinkRisk(ctx, body.riskId, params.nodeId);
        return jsonResponse({ success: true });
    }),
);
