/**
 * `/api/t/:slug/admin/agents/:agentId/profile/versions/:version/approve` (Step
 * 1a, #4143): SUBMITTED → APPROVED. The body names the instructions hash the
 * approver read. Refused for the version's author (also a CHECK), for an
 * API-key caller, for a hash that is not the version's, for text the scan now
 * refuses, and for a tool the agent is no longer granted.
 *
 * `admin.agent_registry` (owner decision 3, 2026-10-25). With `AGENT_PROFILES`
 * off it answers 404 before the permission check.
 */
import { NextRequest } from 'next/server';

import {
    AgentProfileVersionParamSchema,
    ApproveAgentProfileVersionSchema,
} from '@/app-layer/schemas/agent-profile.schemas';
import { approveAgentProfileVersion } from '@/app-layer/usecases/agent-profiles';
import { whenAgentProfilesEnabled } from '@/lib/agentic/agent-profile-flag';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; agentId: string; version: string };

export const POST = withApiErrorHandling(
    whenAgentProfilesEnabled(
        requirePermission<Params>('admin.agent_registry', async (req: NextRequest, { params }, ctx) => {
            const { agentId, version } = await params;
            const body = ApproveAgentProfileVersionSchema.parse(await req.json());
            return jsonResponse(
                await approveAgentProfileVersion(ctx, agentId, AgentProfileVersionParamSchema.parse(version), body),
            );
        }),
    ),
);
