/**
 * `/api/t/:slug/admin/agents/external-tools` — an external MCP server's
 * catalogue, and the approval that makes one of its tools grantable.
 *
 * GET `?connectionId=` reads the server's live `tools/list` and returns each
 * tool with its pin state, including which ones the boundary is refusing
 * because their definition moved. POST approves one, naming the hash the
 * operator reviewed.
 *
 * ## Why this is under `/admin/agents` and not `/admin/integrations`
 *
 * The connection is credential wiring and lives in integrations. This is not:
 * a tool's DESCRIPTION is instruction text delivered to a model, and accepting
 * a changed one is an agent-governance decision. The product's own rule —
 * agent governance on `/agents`, MCP credential wiring in admin — puts it
 * here, and the placement is what earns it `admin.agent_registry` through the
 * existing `admin/agents(/.*)?` rule rather than integrations' `admin.manage`.
 *
 * ## Why `admin.agent_registry` specifically
 *
 * Same argument `tool-manifests/route.ts` makes: the three agent keys split by
 * BLAST RADIUS. A pin is tenant-wide — approving a poisoned description hands
 * its instructions to every agent granted that tool at once — so it sits in the
 * registry class, not the per-agent `agent_tool_exposure` one.
 *
 * The gate lives at the ROUTE: a `requirePermission` denial writes a
 * hash-chained `AUTHZ_DENIED` row and a usecase throw records nothing.
 */
import { NextRequest } from 'next/server';

import {
    approveExternalToolManifest,
    listExternalMcpTools,
} from '@/app-layer/usecases/external-mcp-tools';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        const connectionId = new URL(req.url).searchParams.get('connectionId');
        if (!connectionId) {
            // Named rather than defaulted: there is no sensible "all
            // connections" answer here, because each one costs a live
            // `tools/list` against somebody else's server.
            throw badRequest('connectionId is required');
        }
        return jsonResponse(await listExternalMcpTools(ctx, connectionId));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await approveExternalToolManifest(ctx, await req.json()));
    }),
);
