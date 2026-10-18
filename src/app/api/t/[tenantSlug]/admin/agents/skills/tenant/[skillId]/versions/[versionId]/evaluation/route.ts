/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions/:versionId/evaluation`
 * — attach a draft's evaluation record (#3680). The record is the repository's
 * own format; it is checked against this exact version, its pass rates are
 * recomputed from its raw answers, and it is stored once, only if it passes.
 */
import { NextRequest } from 'next/server';

import { AttachTenantSkillEvaluationSchema } from '@/app-layer/schemas/tenant-skill.schemas';
import { attachTenantSkillEvaluation } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string; versionId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_review', async (req: NextRequest, { params }, ctx) => {
        const { skillId, versionId } = await params;
        const body = AttachTenantSkillEvaluationSchema.parse(await req.json());
        return jsonResponse(await attachTenantSkillEvaluation(ctx, skillId, versionId, body));
    }),
);
