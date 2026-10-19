/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions/:versionId/submit`
 * — submit a draft for review (#3680). It needs a passing evaluation record.
 */
import { NextRequest } from 'next/server';

import { submitTenantSkillVersion } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string; versionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_author', async (_req: NextRequest, { params }, ctx) => {
        const { skillId, versionId } = await params;
        return jsonResponse(await submitTenantSkillVersion(ctx, skillId, versionId));
    }),
);
