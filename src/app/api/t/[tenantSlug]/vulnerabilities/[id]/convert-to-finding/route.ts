import { convertVulnerabilityToFinding } from '@/app-layer/usecases/vulnerability';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Explicit, opt-in conversion of a vulnerability into a Finding via the
 * existing createFinding usecase (sourceKind='CVE').
 *
 * `assets.edit` (#4465): the conversion is drawn from the vulnerability and
 * writes onto it. There is no findings key in `PermissionSet` — creating a
 * finding is gated on the coarse write tier, which `createFinding` asserts.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (_req, { params }, ctx) => {
        const { finding, nudge } = await convertVulnerabilityToFinding(ctx, params.id);
        return jsonResponse({ ...finding, nudge }, { status: 201 });
    }),
);
