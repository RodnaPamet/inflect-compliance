/**
 * `/api/t/:slug/admin/agents/harness-estates` — the client estates this tenant's
 * harness scanners cover, and their schedule health (#3678).
 *
 * GET is the inventory read — `admin.agent_registry_view` or the register key —
 * the key the scan list takes, because the health view is built from the scans.
 * POST declares an estate and takes `admin.agent_registry`: which scanner covers
 * which estate, at what cadence and with whom accountable for each source, is
 * the register's decision and never the scanner's own.
 */
import { NextRequest } from 'next/server';

import {
    createHarnessEstate,
    CreateHarnessEstateSchema,
    getHarnessEstateHealth,
} from '@/app-layer/usecases/agent-harness-estates';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' },
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await getHarnessEstateHealth(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = CreateHarnessEstateSchema.parse(await req.json());
            return jsonResponse(await createHarnessEstate(ctx, body), { status: 201 });
        },
    ),
);
