/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId/versions` — edit a tenant
 * skill (#3680). An edit is a NEW version, which starts at DRAFT; any open
 * version is superseded, and the version in service keeps serving until the new
 * one is approved.
 */
import { NextRequest } from 'next/server';

import { TenantSkillTextSchema } from '@/app-layer/schemas/tenant-skill.schemas';
import { createTenantSkillVersion } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_review', async (req: NextRequest, { params }, ctx) => {
        const { skillId } = await params;
        const body = TenantSkillTextSchema.parse(await req.json());
        return jsonResponse(await createTenantSkillVersion(ctx, skillId, body), { status: 201 });
    }),
);
