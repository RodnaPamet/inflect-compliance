/**
 * The organization's two agent switches (#4557).
 *
 *   GET /api/org/[orgSlug]/agent-switches → the organization's choices, beside
 *                                           the deployment's state (read)
 *   PUT /api/org/[orgSlug]/agent-switches → set either or both
 *                                           (canManageAgentSwitches)
 *
 * PUT is mutation-rate-limited (withApiErrorHandling default), refuses through
 * `requireOrgPermission` with an `ORG_AUTHZ_DENIED` row, and audits a change as
 * `ORG_AGENT_SWITCHES_CHANGED` in the usecase.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { getOrgAgentSwitches, setOrgAgentSwitches } from '@/app-layer/usecases/org-agent-switches';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

// STRICT: an unknown key is a 400, so a misspelt switch is refused rather than
// saved as nothing.
const SetAgentSwitchesSchema = z
    .object({
        agentProfiles: z.boolean().optional(),
        toolRunner: z.boolean().optional(),
    })
    .strict()
    .refine((b) => b.agentProfiles !== undefined || b.toolRunner !== undefined, {
        message: 'Send agentProfiles, toolRunner or both.',
    });

export const GET = withApiErrorHandling(async (req: NextRequest, routeCtx: RouteContext) => {
    const ctx = await getOrgCtx(await routeCtx.params, req);
    return NextResponse.json({ switches: await getOrgAgentSwitches(ctx) });
});

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canManageAgentSwitches', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, SetAgentSwitchesSchema);
        return NextResponse.json({ switches: await setOrgAgentSwitches(ctx, body) });
    }),
);
