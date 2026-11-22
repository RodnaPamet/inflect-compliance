import { listControlRisks, mapControlToRisk } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const LinkSchema = z.object({ riskId: z.string().min(1), rationale: z.string().optional() }).strip();

/**
 * Reading this panel takes the ANCHOR entity's view key — the key its own
 * detail read takes — so a refusal is a 403 with an `AUTHZ_DENIED` row (#5376,
 * owner decision 2026-11-12). The usecase refuses the same anchor again and
 * omits each linked kind the caller may not view.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>('controls.view', async (_req, { params }, ctx) =>
        jsonResponse(await listControlRisks(ctx, params.controlId)),
    ),
);

/**
 * `controls.edit`, the same key its sibling `DELETE /risks/:riskId` already
 * requires — someone gated the unmap and missed the map (#4387). So this is
 * matching an established precedent rather than choosing a new policy.
 *
 * NOTE: the usecase behind both is `traceability.ts`'s file-local
 * `assertCanManage`, which checks a role NAME and so is bypassed by any custom
 * role on an OWNER/ADMIN/EDITOR base. This route gate does not fix that, and
 * does not pretend to — it is filed as #4413.
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string }>(
        'controls.edit',
        async (req, { params }, ctx) => {
            const body = LinkSchema.parse(await req.json());
            return jsonResponse(
                await mapControlToRisk(ctx, params.controlId, body.riskId, body.rationale),
                { status: 201 },
            );
        },
    ),
);
