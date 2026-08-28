import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { changeInitiativeStatus, INITIATIVE_STATUSES } from '@/app-layer/usecases/org-security-initiative';

const StatusSchema = z.object({ status: z.enum(INITIATIVE_STATUSES) }).strip();

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string; initiativeId: string }>(
        'canConfigureDashboard',
        async (req, { params }, ctx) => {
            const body = await parseJsonBody(req, StatusSchema);
            return NextResponse.json({
                initiative: await changeInitiativeStatus(ctx, params.initiativeId, body.status),
            });
        },
    ),
);
