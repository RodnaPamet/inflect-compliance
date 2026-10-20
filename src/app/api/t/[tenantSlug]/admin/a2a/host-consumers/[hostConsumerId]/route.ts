/**
 * `/api/t/:slug/admin/a2a/host-consumers/:id` (#3861).
 *
 *   POST   …/rotate-secret   mint a new secret, keep the client id
 *   POST   …/revoke          stop it issuing and stop its live tokens
 *
 * Both are POST to a NAMED action rather than PATCH or DELETE, and the naming
 * is the point. Rotating MINTS something and returns it once, which is a POST.
 * Revoking keeps the row — it is the record of what a host could reach and when
 * — so DELETE would describe the wrong thing, exactly as the agent kill route
 * argues about lifting.
 */
import { NextRequest } from 'next/server';

import { revokeHostConsumer, rotateHostConsumerSecret } from '@/app-layer/usecases/a2a-host-consumers';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

type Params = { tenantSlug: string; hostConsumerId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, p, ctx) => {
        const { hostConsumerId } = await p.params;
        const action = req.nextUrl.searchParams.get('action');
        if (action === 'rotate-secret') {
            return jsonResponse(await rotateHostConsumerSecret(ctx, hostConsumerId));
        }
        if (action === 'revoke') {
            return jsonResponse(await revokeHostConsumer(ctx, hostConsumerId));
        }
        // Named rather than guessed: a typo must not fall through to the more
        // destructive of the two.
        throw badRequest('`action` must be `rotate-secret` or `revoke`');
    }),
);
