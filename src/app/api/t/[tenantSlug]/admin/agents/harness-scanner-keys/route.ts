/**
 * `/api/t/:slug/admin/agents/harness-scanner-keys` — the public keys this
 * tenant trusts to sign harness reports (#3665).
 *
 * `admin.agent_registry`: registering a key decides whose reports count, which
 * is the register's authority and never the scanner's own.
 */
import { NextRequest } from 'next/server';

import {
    addHarnessScannerKey,
    AddHarnessScannerKeySchema,
    listHarnessScannerKeys,
} from '@/app-layer/usecases/agent-harness-scanner-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await listHarnessScannerKeys(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = AddHarnessScannerKeySchema.parse(await req.json());
            return jsonResponse(await addHarnessScannerKey(ctx, body), { status: 201 });
        },
    ),
);
