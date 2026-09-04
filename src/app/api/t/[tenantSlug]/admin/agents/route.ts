/**
 * `/api/t/:slug/admin/agents` — the agent register's list + registration surface.
 *
 * Gated by `requirePermission('admin.agent_registry')`, its own key rather than
 * `admin.manage`: an ACTIVE row in this register is what lets a credential
 * through the `/api/mcp` registration gate, so this is the authority to decide
 * which autonomous agents may act inside the tenant. Denials write a
 * hash-chained `AUTHZ_DENIED` row, which is the reason the gate lives at the
 * route rather than one layer deeper in the usecase — a usecase throw records
 * nothing.
 *
 * POST authors the EU AI Act register entry alongside the agent, in one
 * transaction, by running the deterministic classifier. There is no `riskTier`
 * field on the way in; the client cannot state a tier.
 */
import { NextRequest } from 'next/server';

import { listRegisteredAgents, registerAgent } from '@/app-layer/usecases/agent-registry';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            // A raw query-string value; the repository validates it against the
            // real enum rather than letting Prisma 500 one layer down.
            const status = req.nextUrl.searchParams.get('status') ?? undefined;
            const agents = await listRegisteredAgents(ctx, { status });
            return jsonResponse({ agents });
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const agent = await registerAgent(ctx, await req.json());
            return jsonResponse(agent, { status: 201 });
        },
    ),
);
