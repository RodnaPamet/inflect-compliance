/**
 * The organization's two per-turn caps (#4594): the ceiling of delegations and
 * of tool calls one agent turn may start, for every workspace under it.
 *
 *   GET /api/org/[orgSlug]/agent-turn-caps → the two ceilings (read)
 *   PUT /api/org/[orgSlug]/agent-turn-caps → set either or both
 *                                            (canManageAgentSwitches)
 *
 * A sibling of `agent-switches`, not folded into it: a switch has a
 * deployment override and these do not. PUT is mutation-rate-limited
 * (withApiErrorHandling default), refuses through `requireOrgPermission` with
 * an `ORG_AUTHZ_DENIED` row, and audits a change as
 * `ORG_AGENT_TURN_CAPS_CHANGED` in the usecase.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { getOrgAgentTurnCaps, setOrgAgentTurnCaps } from '@/app-layer/usecases/org-agent-turn-caps';
import { DELEGATIONS_PER_TURN_MIN, TOOL_CALLS_PER_TURN_MIN, TURN_CAP_MAX } from '@/lib/agentic/turn-caps';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

// STRICT: an unknown key is a 400, so a misspelt cap is refused rather than
// saved as nothing.
const SetAgentTurnCapsSchema = z
    .object({
        delegationsPerTurn: z.number().int().min(DELEGATIONS_PER_TURN_MIN).max(TURN_CAP_MAX).optional(),
        toolCallsPerTurn: z.number().int().min(TOOL_CALLS_PER_TURN_MIN).max(TURN_CAP_MAX).optional(),
    })
    .strict()
    .refine((b) => b.delegationsPerTurn !== undefined || b.toolCallsPerTurn !== undefined, {
        message: 'Send delegationsPerTurn, toolCallsPerTurn or both.',
    });

export const GET = withApiErrorHandling(async (req: NextRequest, routeCtx: RouteContext) => {
    const ctx = await getOrgCtx(await routeCtx.params, req);
    return NextResponse.json({ turnCaps: await getOrgAgentTurnCaps(ctx) });
});

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canManageAgentSwitches', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, SetAgentTurnCapsSchema);
        return NextResponse.json({ turnCaps: await setOrgAgentTurnCaps(ctx, body) });
    }),
);
