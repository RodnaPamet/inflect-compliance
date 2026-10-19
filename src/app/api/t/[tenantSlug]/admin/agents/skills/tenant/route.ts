/**
 * `/api/t/:slug/admin/agents/skills/tenant` — author a tenant skill (#3680,
 * step 4c). The body is the skill's name and the fields of its version 1, which
 * starts at DRAFT and mounts nothing until a person other than its author has
 * approved it.
 *
 * `admin.agent_skill_author` (#3778): authoring is its own key, so a provider
 * that writes a tenant's skills can hold it without the approval key. The
 * four-eyes rule is also the author/approver split the usecase and a CHECK
 * hold. The listing of tenant skills is part of `GET …/agents/skills`.
 */
import { NextRequest } from 'next/server';

import { CreateTenantSkillSchema } from '@/app-layer/schemas/tenant-skill.schemas';
import { createTenantSkill } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_skill_author', async (req: NextRequest, _routeArgs, ctx) => {
        const body = CreateTenantSkillSchema.parse(await req.json());
        return jsonResponse(await createTenantSkill(ctx, body), { status: 201 });
    }),
);
