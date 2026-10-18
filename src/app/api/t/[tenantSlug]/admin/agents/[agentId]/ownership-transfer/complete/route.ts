/**
 * `/api/t/:slug/admin/agents/:agentId/ownership-transfer/complete` — step two of
 * a two-step agent ownership transfer (#3698).
 *
 * POST `{ transferId }` — the person the transfer names accepts it, and the
 * agent's accountable owner moves to them. Refused for anyone else, and above
 * all for the person who STARTED it: the usecase asks that first, from the
 * stored row, and the table's CHECKs make a completion by anyone but the
 * recipient unrepresentable. The completer names the transfer they read, so a
 * cancel and a fresh proposal cannot swap what they accept underneath them.
 *
 * Same key as step one, `admin.tenant_lifecycle` (step 0e): the recipient must
 * hold it too, so with the built-in roles an agent passes only to an OWNER. That
 * narrowing was accepted by the owner in 0e, and on 2026-10-18 as the interim
 * state until a built-in `AI_ADMIN` role widens it in its own pull request.
 * And this path is under `/admin/`,
 * so the edge middleware refuses any session whose BUILT-IN role is not ADMIN
 * or OWNER before this handler runs: a custom role carrying the key admits an
 * ADMIN membership here and no other (`TRANSFER_RECIPIENT_MEMBERSHIP_ROLES`,
 * which step one checks). Its `ROUTE_PERMISSIONS` rule sits above the
 * `admin/agents(/.*)?` catch-all. Human-only: no API key carries the key.
 */
import { NextRequest } from 'next/server';

import { completeAgentOwnershipTransfer } from '@/app-layer/usecases/agent-ownership-transfer';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await completeAgentOwnershipTransfer(ctx, agentId, await req.json()));
        },
    ),
);
