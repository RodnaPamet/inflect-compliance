/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions/:versionId/reject`
 * — reject a version in review (#3680). It is retired; the author edits the
 * skill, which is a new version, to try again.
 */
import { NextRequest } from 'next/server';

import { rejectTenantSkillVersion } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string; versionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_review', async (_req: NextRequest, { params }, ctx) => {
        const { skillId, versionId } = await params;
        return jsonResponse(await rejectTenantSkillVersion(ctx, skillId, versionId));
    }),
);
