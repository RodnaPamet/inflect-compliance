/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions/:versionId/retire`
 * — take a version out of service, or withdraw a draft or one in review
 * (#3680). RETIRED is terminal. A retired version stops mounting at the next run.
 */
import { NextRequest } from 'next/server';

import { retireTenantSkillVersion } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string; versionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_review', async (_req: NextRequest, { params }, ctx) => {
        const { skillId, versionId } = await params;
        return jsonResponse(await retireTenantSkillVersion(ctx, skillId, versionId));
    }),
);
