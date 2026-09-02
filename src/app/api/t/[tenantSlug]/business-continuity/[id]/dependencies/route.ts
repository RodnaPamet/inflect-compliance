import { z } from 'zod';
import { addBiaDependency } from '@/app-layer/usecases/business-impact-analysis';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

const AddDependencySchema = z.object({
    dependsOnType: z.enum(['PROCESS', 'ASSET', 'VENDOR', 'RISK']),
    dependsOnId: z.string().min(1),
});

type Params = { tenantSlug: string; id: string };

/**
 * POST — attach a dependency (process/asset/vendor/risk) to this BIA.
 *
 * Gated on `continuity.edit` with its DELETE sibling (#2197). The register is
 * gated whole rather than half: leaving the attach on the bare usecase assert
 * while the detach audits would make the trail describe one direction of the
 * same edge.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, AddDependencySchema);
        return jsonResponse(await addBiaDependency(ctx, params.id, body), { status: 201 });
    }),
);
