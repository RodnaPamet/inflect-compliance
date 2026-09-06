/**
 * `/api/t/:slug/admin/agents/:agentId/circuit-breaker` — the behavioural
 * breaker, and the switch back.
 *
 * GET  — the latch, the recent window ledger, and the thresholds in force.
 * POST — CLOSE a tripped breaker. The only thing that un-trips an agent.
 *
 * ## Why `admin.agent_registry` and not a key of its own
 *
 * It resolves through the `admin/agents(/.*)?` catch-all, and that is the right
 * key rather than a convenient one: closing a breaker is the authority to decide
 * that an agent may act, which is exactly what that key's own note says it is.
 * A narrower key would let somebody who cannot activate an agent un-stop one
 * that stopped itself, which is the same authority wearing a smaller name.
 *
 * ## Why the gate is at the ROUTE
 *
 * `requirePermission` writes a hash-chained `AUTHZ_DENIED` row on refusal and
 * returns a generic 403 that never echoes the key. A usecase `assertCanAdmin`
 * throw records NOTHING — the defect Epic D.3 fixed for seven tenant routes.
 * Un-stopping an autonomous agent is the last place to lose that row.
 *
 * ## The body carries a REASON, and the schema is `.strict()`
 *
 * `ACCEPTED_NEW_BASELINE` discards the agent's history; `RESOLVED` keeps it.
 * They are not interchangeable — see `closeAgentCircuitBreaker` — so the reason
 * is required rather than defaulted, and an unknown key is refused rather than
 * dropped: a close is a decision, and a decision nobody made must not be
 * inferred from a body that happened to omit a field.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
    closeAgentCircuitBreaker,
    getAgentCircuitBreaker,
} from '@/app-layer/usecases/agent-circuit-breaker';
import { BREAKER_CLOSE_REASONS } from '@/lib/agentic/circuit-breaker';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; agentId: string };

/**
 * Defined from the ladder constant rather than re-typed. The identity
 * subsystem's route once held a verbatim fourth copy of a ladder and went on
 * offering a rung the ladder no longer had; `z.enum` over the exported tuple
 * makes that spelling impossible.
 */
const CloseBreakerSchema = z
    .object({ reason: z.enum(BREAKER_CLOSE_REASONS) })
    .strict();

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        // `{ params }` destructured then awaited — the house pattern; see the
        // sibling route files for why an explicit `Promise<Params>` annotation
        // cannot compile against `PermissionedHandler`.
        async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentCircuitBreaker(ctx, agentId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const { reason } = await parseJsonBody(req, CloseBreakerSchema);
            return jsonResponse(await closeAgentCircuitBreaker(ctx, agentId, reason));
        },
    ),
);
