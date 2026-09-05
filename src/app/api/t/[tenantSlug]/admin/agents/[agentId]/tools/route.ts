/**
 * `/api/t/:slug/admin/agents/:agentId/tools` — deny-by-default MCP tool exposure.
 *
 * The list an agent's `/api/mcp` calls are checked against. A tool absent from it
 * is unreachable however widely the credential is scoped, so adding one is a
 * privileged act and carries its own permission key,
 * `admin.agent_tool_exposure` — separate from `admin.agent_registry` because the
 * two decide different things: the register decides WHETHER an agent may act,
 * this decides WHAT it may reach, and the second moves every time somebody wires
 * up an automation.
 *
 * The gate lives at the ROUTE, not one layer deeper: a `requirePermission`
 * denial writes a hash-chained `AUTHZ_DENIED` row and a usecase throw records
 * nothing. Its rule must sit ABOVE the generic `admin/agents(/.*)?` entry in
 * `ROUTE_PERMISSIONS`, which matches first-wins.
 *
 * DELETE takes the tool name from `?tool=`, not a body: revocation is the
 * emergency direction and has to work from anything that can form a URL.
 */
import { NextRequest } from 'next/server';

import {
    grantAgentTool,
    listAgentTools,
    revokeAgentTool,
} from '@/app-layer/usecases/agent-tool-exposure';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_tool_exposure',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await listAgentTools(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_tool_exposure',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const granted = await grantAgentTool(ctx, agentId, await req.json());
            return jsonResponse(granted, { status: 201 });
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_tool_exposure',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const toolName = req.nextUrl.searchParams.get('tool');
            if (!toolName) throw badRequest('A `tool` query parameter is required');
            return jsonResponse(await revokeAgentTool(ctx, agentId, toolName));
        },
    ),
);
