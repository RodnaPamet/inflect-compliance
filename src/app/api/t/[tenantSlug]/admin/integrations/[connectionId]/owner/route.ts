/**
 * PUT /api/t/{slug}/admin/integrations/{connectionId}/owner — name (or clear)
 * the person accountable for an external agent connection (#3672).
 *
 * The integration passport's field P11. Until a connection has one, the weekly
 * sweep raises CONNECTION_OWNER_MISSING (HIGH) and every other finding on that
 * connection falls to the tenant's OWNER role with no assignee.
 *
 * `admin.manage`, the connection-write permission — the same key every other
 * route under `admin/integrations` holds, and the rule that path already
 * resolves to, so this route needs no rule of its own. Its own route rather than
 * a field on the connection upsert: the upsert defaults `isEnabled` to true, so
 * naming an owner through it would re-enable a disabled connection.
 *
 * Body: `{ "ownerUserId": "<user id>" | null }`, strict. The owner must hold an
 * ACTIVE membership of this tenant; `null` clears it. Only `mcp-server`
 * connections have an owner — any other id is a 404.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { setIntegrationConnectionOwner } from '@/app-layer/usecases/integration-passport';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

const Body = z.object({ ownerUserId: z.string().min(1).max(64).nullable() }).strict();

type Params = { tenantSlug: string; connectionId: string };

const putHandler = requirePermission<Params>(
    'admin.manage',
    async (req: NextRequest, { params }, ctx) => {
        const { ownerUserId } = Body.parse(await req.json());
        const result = await setIntegrationConnectionOwner(ctx, params.connectionId, ownerUserId);
        return jsonResponse(result);
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, so a denial becomes the
// standard error response and its AUTHZ_DENIED audit row is written.
export const PUT = withApiErrorHandling(putHandler);
