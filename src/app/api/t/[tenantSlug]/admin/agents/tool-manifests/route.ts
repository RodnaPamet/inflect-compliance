/**
 * `/api/t/:slug/admin/agents/tool-manifests` — the tool-manifest pin surface.
 *
 * GET lists every tool this build defines with its pin state, including which
 * ones the MCP boundary is currently REFUSING because their definition changed.
 * POST approves one, naming the hash the operator reviewed.
 *
 * ## The key, and why it is `admin.agent_registry` rather than a fourth one
 *
 * The three agent keys split by BLAST RADIUS, not by subject: `agent_registry`
 * decides whether an agent may act in the tenant at all, `agent_tool_exposure`
 * decides what ONE agent may reach, `agent_policy_card` bounds ONE agent's
 * runtime. A manifest approval is none of those — it is tenant-wide and applies
 * to every agent at once, which puts it in the first class, not the second or
 * third. Approving a poisoned description would hand its instructions to every
 * agent in the tenant simultaneously, so folding it into the per-agent grant key
 * would be the exact composition `agent_tool_exposure`'s own docstring rejects
 * one level down: a routine "let the reporting agent read tasks too" must not
 * also carry the authority to accept a rewritten tool description.
 *
 * It resolves through the existing `admin/agents(/.*)?` rule in ROUTE_PERMISSIONS
 * rather than a new one, so there is no second place for the mapping to drift.
 *
 * The gate lives at the ROUTE: a `requirePermission` denial writes a
 * hash-chained `AUTHZ_DENIED` row and a usecase throw records nothing. The 403
 * body never names the key.
 */
import { NextRequest } from 'next/server';

import { approveToolManifest, listToolManifests } from '@/app-layer/usecases/mcp-tool-manifest';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, _c, ctx) => {
        return jsonResponse(await listToolManifests(ctx));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await approveToolManifest(ctx, await req.json()));
    }),
);
