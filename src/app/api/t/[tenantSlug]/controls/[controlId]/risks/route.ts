import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listControlRisks, mapControlToRisk } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const LinkSchema = z.object({ riskId: z.string().min(1), rationale: z.string().optional() }).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; controlId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await listControlRisks(ctx, params.controlId));
});

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
