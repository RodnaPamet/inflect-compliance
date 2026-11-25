/**
 * `/api/t/:slug/admin/agents/prober-keys/:keyId` — revoke a prober key. The row
 * stays for the runs it signed; it verifies nothing new.
 */
import { NextRequest } from 'next/server';

import { revokeAgentProberKey } from '@/app-layer/usecases/agent-prober-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; keyId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { keyId } = await params;
            return jsonResponse(await revokeAgentProberKey(ctx, { keyId }));
        },
    ),
);
