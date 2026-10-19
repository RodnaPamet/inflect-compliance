/**
 * `/api/t/:slug/admin/agents/a2a-signing-key` — the tenant's own A2A signing
 * key (#3679; owner decision 2026-10-19).
 *
 *   GET   the public half: the key in force (or null) and the retired ones.
 *         `admin.agent_registry` — the person who hands a peer its credential
 *         hands it this key too.
 *   POST  generate the first key, or rotate to a fresh one. `admin.tenant_lifecycle`
 *         — OWNER only, the key that rotates the tenant's DEK — and never an
 *         API key (the usecase refuses one). Audited.
 *
 * Two rules in `route-permissions.ts`, method-scoped, ABOVE the `/admin/agents`
 * catch-all, because first match wins and the catch-all names the register key.
 * No response carries the private seed.
 */
import { NextRequest } from 'next/server';

import { getTenantA2aSigningKeys, rotateTenantA2aSigningKey } from '@/app-layer/usecases/a2a-signing-key';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, _routeArgs, ctx) =>
        jsonResponse(await getTenantA2aSigningKeys(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.tenant_lifecycle', async (_req: NextRequest, _routeArgs, ctx) =>
        jsonResponse(await rotateTenantA2aSigningKey(ctx), { status: 201 }),
    ),
);
