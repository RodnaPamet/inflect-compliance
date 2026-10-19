/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions/:versionId/approve`
 * — approve a version in review (#3680). The body names the content hash the
 * approver reviewed. Refused for the version's author (also a CHECK), for an
 * API-key caller, for a hash that is not the version's, and wherever the mount
 * gate or the combined catalogue budget would refuse a run.
 */
import { NextRequest } from 'next/server';

import { ApproveTenantSkillSchema } from '@/app-layer/schemas/tenant-skill.schemas';
import { approveTenantSkillVersion } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string; versionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_review', async (req: NextRequest, { params }, ctx) => {
        const { skillId, versionId } = await params;
        const body = ApproveTenantSkillSchema.parse(await req.json());
        return jsonResponse(await approveTenantSkillVersion(ctx, skillId, versionId, body));
    }),
);
