/**
 * `/api/t/:slug/admin/agents/harness-scanner-keys/:keyId` — revoke a scanner
 * key (#3665). The row stays for the scans it signed; it verifies nothing new.
 */
import { NextRequest } from 'next/server';

import { revokeHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; keyId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { keyId } = await params;
            return jsonResponse(await revokeHarnessScannerKey(ctx, { keyId }));
        },
    ),
);
