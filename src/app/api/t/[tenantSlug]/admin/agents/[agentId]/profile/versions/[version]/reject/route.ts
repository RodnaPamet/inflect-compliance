/**
 * `/api/t/:slug/admin/agents/:agentId/profile/versions/:version/reject` (Step 1a,
 * #4143): SUBMITTED → REJECTED, by a signed-in person other than the version's author (also a CHECK).
 *
 * `admin.agent_registry`. With `AGENT_PROFILES` off it answers 404 before the
 * permission check.
 */
import { NextRequest } from 'next/server';

import { AgentProfileVersionParamSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { rejectAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string; version: string };

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
            const { agentId, version } = await params;
            return jsonResponse(await rejectAgentProfileVersion(ctx, agentId, AgentProfileVersionParamSchema.parse(version)));
        }),
    ),
);
