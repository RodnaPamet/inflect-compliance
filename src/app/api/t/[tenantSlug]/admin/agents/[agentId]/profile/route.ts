/**
 * `/api/t/:slug/admin/agents/:agentId/profile` — one agent's profile (Step 1a,
 * #4143). GET reads the profile and its newest versions, instructions included,
 * so a reviewer reads the text they approve. POST creates the profile with
 * version 1 at DRAFT, authored by the caller.
 *
 * `admin.agent_registry` (owner decision 3, 2026-10-25). With `AGENT_PROFILES`
 * off it answers 404 before the permission check.
 */
import { NextRequest } from 'next/server';

import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { createAgentProfile, getAgentProfile } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string };

export const GET = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            return jsonResponse(await getAgentProfile(ctx, agentId));
        }),
    ),
);

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const body = AgentProfileVersionSchema.parse(await req.json());
            return jsonResponse(await createAgentProfile(ctx, agentId, body), { status: 201 });
        }),
    ),
);
