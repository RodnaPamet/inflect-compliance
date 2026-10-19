/**
 * `/api/t/:slug/admin/agents/skills/tenant/:skillId` — one tenant skill and its
 * versions, for authoring and review (#3680, #3778). It returns each version's instructions, so a
 * reviewer reads the text they approve, except a version the skill text scan
 * refuses, which is shown by rule id only.
 */
import { NextRequest } from 'next/server';

import { getTenantSkill } from '@/app-layer/usecases/tenant-skills';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; skillId: string };

export const GET = withApiErrorHandling(
    // Either half (#3778): the author edits from these versions, the reviewer
    // approves from them.
    requirePermission<Params>(
        { keys: ['admin.agent_skill_author', 'admin.agent_skill_review'], mode: 'any' },
        async (_req: NextRequest, { params }, ctx) => {
            const { skillId } = await params;
            return jsonResponse(await getTenantSkill(ctx, skillId));
        },
    ),
);
