/**
 * `/api/t/:slug/admin/agents/:agentId/profile/versions` — edit a profile (Step
 * 1a, #4143): a NEW version at DRAFT, authored by the caller. An open version
 * is retired first; the version in force keeps running until the new one is
 * approved by someone else.
 *
 * `admin.agent_registry`. With `AGENT_PROFILES` off it answers 404 before the
 * permission check.
 */
import { NextRequest } from 'next/server';

import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { createAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string };

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
            const { agentId } = await params;
            const body = AgentProfileVersionSchema.parse(await req.json());
            return jsonResponse(await createAgentProfileVersion(ctx, agentId, body), { status: 201 });
        }),
    ),
);
