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
 * writes onto it. And `findings.create` (#4535), as `convert-to-risk` asks
 * `risks.create`: it creates a finding, which the findings register's own
 * route asks of the caller. Every built-in role holding `assets.edit` holds
 * `findings.create` too, so only a custom role can tell them apart.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>(['assets.edit', 'findings.create'], async (_req, { params }, ctx) => {
        const { finding, nudge } = await convertVulnerabilityToFinding(ctx, params.id);
        return jsonResponse({ ...finding, nudge }, { status: 201 });
    }),
);
