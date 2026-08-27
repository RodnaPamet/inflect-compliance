/**
 * Risk scenarios — GET detail, DELETE archives.
 *
 * The DELETE gate is `risks.edit`, mirroring `archiveScenario`'s
 * `assertCanWrite`. Two things follow from that pairing:
 *
 *  - A refusal now writes a hash-chained `AUTHZ_DENIED` row. `assertCanWrite`
 *    throws 403 and records nothing, so an attempt to archive a scenario the
 *    caller may not touch left no trace (#2117).
 *  - The gate reads `appPermissions`, which honours custom-role overrides;
 *    `assertCanWrite` reads `permissions.canWrite`, which is computed from the
 *    built-in role tier ALONE and ignores them. A tenant who denied
 *    `risks.edit` on a custom role was being overruled here. For the five
 *    built-in roles the two agree exactly, so this changes nothing for them.
 *
 * The usecase assert stays: it is what protects non-HTTP callers.
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { getScenario, archiveScenario } from '@/app-layer/usecases/risk-scenario';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; scenarioId: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse({ scenario: await getScenario(ctx, params.scenarioId) });
    },
);

type Params = { tenantSlug: string; scenarioId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (_req, { params }, ctx) => {
        await archiveScenario(ctx, params.scenarioId);
        return jsonResponse({ success: true });
    }),
);
