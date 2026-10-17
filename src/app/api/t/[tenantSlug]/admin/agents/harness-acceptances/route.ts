/**
 * `/api/t/:slug/admin/agents/harness-acceptances` — time-limited acceptances
 * of a harness shortfall (#3665).
 *
 * `admin.agent_registry` at the route; the usecase also requires the caller to
 * be the agent's owner, because accepting a risk is the accountable person's
 * act. An acceptance closes the shortfall finding until it expires, when the
 * nightly expiry monitor reopens it if the agent is still below the bar.
 */
import { NextRequest } from 'next/server';

import {
    acceptHarnessShortfall,
    AcceptHarnessShortfallSchema,
    listHarnessAcceptances,
} from '@/app-layer/usecases/agent-harness-acceptance';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) =>
            jsonResponse(await listHarnessAcceptances(ctx, req.nextUrl.searchParams.get('discoveredAgentId') ?? undefined)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = AcceptHarnessShortfallSchema.parse(await req.json());
            return jsonResponse(await acceptHarnessShortfall(ctx, body), { status: 201 });
        },
    ),
);
