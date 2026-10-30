/**
 * `/api/t/:slug/admin/agents/:agentId/profile/versions/:version/test-run` (Step
 * 2c, #4150): start a read-only Test run of one version of the agent's profile,
 * as that agent, on the Tool Runner engine.
 *
 * `admin.agent_registry`, the key every profile route takes. With
 * `AGENT_PROFILES` off it answers 404 before the permission check. The usecase
 * refuses a caller that is not a signed-in person.
 */
import { NextRequest } from 'next/server';

import { AgentProfileVersionParamSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { startAgentProfileTestRun } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string; version: string };

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (_req: NextRequest, { params }, ctx) => {
            const { agentId, version } = await params;
            const started = await startAgentProfileTestRun(ctx, agentId, AgentProfileVersionParamSchema.parse(version));
            return jsonResponse(started, { status: 201 });
        }),
    ),
);
