import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { linkWork, INITIATIVE_LINK_TYPES } from '@/app-layer/usecases/org-security-initiative';

const LinkSchema = z
    .object({ tenantId: z.string().min(1), entityType: z.enum(INITIATIVE_LINK_TYPES), entityId: z.string().min(1) })
    .strip();

export const POST = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string; initiativeId: string }>(
        'canConfigureDashboard',
        async (req, { params }, ctx) => {
            const body = await parseJsonBody(req, LinkSchema);
            return NextResponse.json({ link: await linkWork(ctx, params.initiativeId, body) });
        },
    ),
);
