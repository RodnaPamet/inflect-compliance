/**
 * `/api/t/:slug/admin/probe-approver-keys` — the public keys allowed to
 * authorise a probe engagement: they sign the engagement scope a prober runs
 * under (active flavour, step 8a).
 *
 * `admin.tenant_lifecycle`, OWNER-only (owner decision, 2026-11-25): who may
 * authorise probing this tenant's agents is the owner's decision. A sibling of
 * `admin/agents/`, not under it, so the agent register's catch-all rule and the
 * AI admin's agent paths never reach it.
 */
import { NextRequest } from 'next/server';

import {
    addProbeApproverKey,
    AddProbeApproverKeySchema,
    listProbeApproverKeys,
} from '@/app-layer/usecases/probe-approver-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (_req: NextRequest, _routeArgs, ctx) => jsonResponse(await listProbeApproverKeys(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = AddProbeApproverKeySchema.parse(await req.json());
            return jsonResponse(await addProbeApproverKey(ctx, body), { status: 201 });
        },
    ),
);
