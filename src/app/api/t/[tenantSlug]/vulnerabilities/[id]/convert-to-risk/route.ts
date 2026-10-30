import { convertVulnerabilityToRisk } from '@/app-layer/usecases/vulnerability';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Explicit, opt-in conversion of a vulnerability into a Risk via the existing
 * createRisk usecase (connects vuln management into the risk graph).
 *
 * Two keys, both required (#4465): `assets.edit`, because the conversion is
 * drawn FROM the vulnerability and writes onto it (its pointer to the risk, the
 * asset↔risk link) — the rule #4413 set for mappings — and `risks.create`,
 * because it creates a risk, the key the risk register's own create route asks.
 * Every built-in role holds both or neither, so no built-in role changes.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>(['assets.edit', 'risks.create'], async (_req, { params }, ctx) => {
        const risk = await convertVulnerabilityToRisk(ctx, params.id);
        return jsonResponse(risk, { status: 201 });
    }),
);
