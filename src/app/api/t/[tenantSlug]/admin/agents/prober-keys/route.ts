/**
 * `/api/t/:slug/admin/agents/prober-keys` — the public keys this tenant trusts
 * to sign probe reports (`scanent-probes/1`; active flavour, step 8a).
 *
 * `admin.agent_registry`: registering a key decides whose probe reports count,
 * which is the register's authority and never the prober's own.
 */
import { NextRequest } from 'next/server';

import { addAgentProberKey, AddAgentProberKeySchema, listAgentProberKeys } from '@/app-layer/usecases/agent-prober-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await listAgentProberKeys(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = AddAgentProberKeySchema.parse(await req.json());
            return jsonResponse(await addAgentProberKey(ctx, body), { status: 201 });
        },
    ),
);
