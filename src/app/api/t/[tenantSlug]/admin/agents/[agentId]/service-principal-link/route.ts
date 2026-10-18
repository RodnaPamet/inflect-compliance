/**
 * `/api/t/:slug/admin/agents/:agentId/service-principal-link` — a person
 * confirms which Entra service principal is the agent's own (#3671, 2c).
 *
 * GET  — the harness's `entra:sp:` links for the agent, each with whether a
 *        live confirmation of exactly that link exists, and the confirmation
 *        history (invalidated ones included).
 * POST — `{ discoveredAgentId }` confirms that the discovered principal is the
 *        agent's. 201 when a confirmation is created, 200 when a live one of the
 *        same link already existed.
 *
 * ## Why this exists
 *
 * The owner-orphan pass disables a contained agent's principal through the
 * external write ladder, and the link it acts on is the harness scanner's
 * reconciliation. Owner decision, 2026-10-18: at AUTOMATIC — a write with no
 * person in it — that link must have been confirmed by a person. This is where
 * that happens. The confirmation is one-way (a database trigger) and a scan
 * that moves the link invalidates it.
 *
 * ## Why `admin.agent_registry`, at the route
 *
 * The register key: deciding which directory identity IS a registered agent is
 * register authority, the same judgement as registering it. ADMIN, OWNER and
 * AI_ADMIN hold it; no API-key scope carries it, so a scanner's own key cannot
 * confirm the links its reports claim. The literal `requirePermission` is the
 * gate because only its denial writes the hash-chained `AUTHZ_DENIED` row; the
 * register's `admin/agents(/.*)?` rule in `ROUTE_PERMISSIONS` records the same
 * key, and an explicit rule above it states the decision.
 */
import { NextRequest } from 'next/server';

import {
    confirmServicePrincipalLink,
    getServicePrincipalLinkState,
} from '@/app-layer/usecases/agent-service-principal-confirmation';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getServicePrincipalLinkState(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const result = await confirmServicePrincipalLink(ctx, agentId, await req.json());
            return jsonResponse(result, { status: result.created ? 201 : 200 });
        },
    ),
);
