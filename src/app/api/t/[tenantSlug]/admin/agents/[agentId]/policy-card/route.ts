/**
 * `/api/t/:slug/admin/agents/:agentId/policy-card` — the agent's machine-readable
 * runtime policy.
 *
 * GET  — the card, the version in force, the whole version history, and (when
 *        there is no card yet) exactly what creating one would produce.
 * POST — create it, seeded from what is already true.
 * PUT  — append a version: one rung of widening, any amount of narrowing.
 *
 * ## Why its own permission key
 *
 * `admin.agent_policy_card`, not `admin.agent_tool_exposure` and not
 * `admin.agent_registry`. A card declares the permitted tools AND the data rung
 * AND the autonomy rung AND the per-run and per-day action budgets AND how many
 * humans must sign what the agent proposes — it is the WIDEST of the three
 * agent surfaces, not the narrowest. Sharing the tool-exposure key would mean
 * every routine "let the reporting agent read tasks too" grant also carried the
 * authority to raise that agent's autonomy ceiling and its budgets, which is
 * exactly the composition that key's own docstring rejects one level down.
 *
 * Its rule must sit ABOVE the `admin/agents(/.*)?` catch-all in
 * `ROUTE_PERMISSIONS`, which matches first-wins.
 *
 * ## Why the gate is at the ROUTE
 *
 * `requirePermission` writes a hash-chained `AUTHZ_DENIED` row on refusal and
 * returns a generic 403 that never echoes the key. A usecase `assertCanWrite`
 * throw records NOTHING — which is how an agent denial used to be invisible, and
 * is the defect Epic D.3 fixed for seven tenant routes. Editing the policy that
 * bounds an autonomous agent is the last place to lose that row.
 *
 * ## PUT, not PATCH
 *
 * The body carries the WHOLE card plus the `expectedVersion` it was composed
 * against. A partial edit would need a merge, and a merge is where a widening
 * hides: the ladder measures a step between two complete cards, and a dimension
 * the caller did not mention is a dimension nobody decided about. `.strict()` on
 * the schema refuses an unknown key rather than dropping it silently.
 */
import { NextRequest } from 'next/server';

import {
    createAgentPolicyCard,
    getAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_policy_card',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentPolicyCard(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_policy_card',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            // No body: a card is SEEDED from what is already true — the agent's
            // current grants, the register's own data-access axis, and the
            // assessed tier's autonomy cap and budgets. Accepting a body here
            // would let the first version be composed rather than observed, and
            // a first version nobody can compare against is a first version the
            // one-rung ladder cannot bound.
            return jsonResponse(await createAgentPolicyCard(ctx, agentId), { status: 201 });
        },
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_policy_card',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await updateAgentPolicyCard(ctx, agentId, await req.json()));
        },
    ),
);
