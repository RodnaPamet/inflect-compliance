/**
 * `/api/t/:slug/admin/a2a/host-consumers` — the hosts that may call us as a
 * CLIENT (#3861).
 *
 * `admin.agent_registry`, the owner's decision in ADR 0003: a host consumer is
 * "whom may call us", which is register-shaped rather than call-shaped, so R3's
 * own split points at the register key. The reservation it accepts — that this
 * bundles admitting an outside system with managing our own register — is
 * written down there rather than discovered later.
 *
 * The gate is the literal `requirePermission` here, which is what denies the
 * request and writes the hash-chained `AUTHZ_DENIED` row; the usecase's own
 * check is defence in depth and records nothing. `route-permissions.ts` carries
 * the matching declarative entry.
 *
 * POST returns the client secret ONCE. It is the only time: the row holds a
 * SHA-256, so an operator who loses it rotates rather than recovers.
 */
import { NextRequest } from 'next/server';

import { createHostConsumer, listHostConsumers } from '@/app-layer/usecases/a2a-host-consumers';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, _p, ctx) =>
        jsonResponse(await listHostConsumers(ctx)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _p, ctx) => {
        const made = await createHostConsumer(ctx, await req.json());
        // The secret travels in the body of a 201 and nowhere else — never a
        // query string, never a header, never a log line.
        return jsonResponse(made, { status: 201 });
    }),
);
