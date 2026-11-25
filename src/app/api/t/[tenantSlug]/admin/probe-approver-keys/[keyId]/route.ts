/**
 * `/api/t/:slug/admin/probe-approver-keys/:keyId` — revoke a probe approver
 * key. From then on a report whose scope it signed is refused; the row stays
 * for the runs it authorised.
 */
import { NextRequest } from 'next/server';

import { revokeProbeApproverKey } from '@/app-layer/usecases/probe-approver-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; keyId: string };

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (_req: NextRequest, { params }, ctx) => {
            const { keyId } = await params;
            return jsonResponse(await revokeProbeApproverKey(ctx, { keyId }));
        },
    ),
);
