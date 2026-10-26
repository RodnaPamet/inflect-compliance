/**
 * `/api/t/:slug/admin/agents/:agentId/profile/versions/:version/retire` (Step 1a,
 * #4143): any status but RETIRED → RETIRED. Retiring the version in force clears the profile's pointer, so it runs nothing until another version is approved.
 *
 * `admin.agent_registry`. With `AGENT_PROFILES` off it answers 404 before the
 * permission check.
 */
import { NextRequest } from 'next/server';

import { AgentProfileVersionParamSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { retireAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string; version: string };

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
            const { agentId, version } = await params;
            return jsonResponse(await retireAgentProfileVersion(ctx, agentId, AgentProfileVersionParamSchema.parse(version)));
        }),
    ),
);
