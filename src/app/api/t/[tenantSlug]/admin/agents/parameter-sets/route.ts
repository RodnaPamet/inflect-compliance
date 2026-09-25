/**
 * `/api/t/:slug/admin/agents/parameter-sets` — saved arguments for external tools.
 *
 * GET lists this tenant's sets with their approval state, including any edit
 * still waiting for a human. POST saves a baseline, PATCH proposes a change, and
 * PUT accepts one, naming the hash the operator reviewed.
 *
 * ## Why `admin.agent_registry` and not `agent_tool_exposure`
 *
 * The three agent keys split by BLAST RADIUS, not by subject — the reasoning is
 * `tool-manifests/route.ts`'s and it lands the same way here. `agent_tool_exposure`
 * decides what ONE agent may reach. A parameter set is keyed by (tenant, tool,
 * label) and NOT by agent, so editing one changes what EVERY agent granted that
 * tool will send. That is the tenant-wide class, the same one a manifest
 * approval sits in, and folding it into the per-agent grant key would be the
 * composition `agent_tool_exposure`'s own docstring rejects: a routine "let the
 * reporting agent read tasks too" must not also carry the authority to rewrite
 * the query every agent runs.
 *
 * It resolves through the existing `admin/agents(/.*)?` rule in ROUTE_PERMISSIONS
 * rather than a new one, so there is no second place for the mapping to drift.
 *
 * ## Four methods on one collection, deliberately
 *
 * The two privileged acts are PROPOSE and APPROVE, and they must be separable —
 * that separation is the whole point of the pending columns. Giving each its own
 * HTTP verb keeps them distinguishable in the access log and in
 * `requirePermission`'s audit row, which a single POST carrying a discriminator
 * in its body would not: a reviewer reading the trail could not tell an edit
 * from an acceptance without parsing the payload.
 *
 * The gate lives at the ROUTE: a `requirePermission` denial writes a
 * hash-chained `AUTHZ_DENIED` row and a usecase throw records nothing. The 403
 * body never names the key.
 */
import { NextRequest } from 'next/server';

import {
    approveParameterChange,
    listParameterSets,
    proposeParameterChange,
    saveParameterSet,
} from '@/app-layer/usecases/external-tool-parameters';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        const toolName = new URL(req.url).searchParams.get('toolName') ?? undefined;
        return jsonResponse(await listParameterSets(ctx, toolName));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await saveParameterSet(ctx, await req.json()));
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await proposeParameterChange(ctx, await req.json()));
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>('admin.agent_registry', async (req: NextRequest, _c, ctx) => {
        return jsonResponse(await approveParameterChange(ctx, await req.json()));
    }),
);
