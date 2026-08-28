import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { listInitiatives, createInitiative } from '@/app-layer/usecases/org-security-initiative';

interface RC { params: Promise<{ orgSlug: string }> }

const CreateSchema = z
    .object({
        title: z.string().min(1).max(200),
        description: z.string().max(8000).nullish(),
        ownerUserId: z.string().nullish(),
        targetDate: z.string().nullish(),
    })
    .strip();

export const GET = withApiErrorHandling(async (req: NextRequest, rc: RC) => {
    const ctx = await getOrgCtx(await rc.params, req);
    return NextResponse.json({ initiatives: await listInitiatives(ctx) });
});

export const POST = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canConfigureDashboard', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, CreateSchema);
        const created = await createInitiative(ctx, {
            title: body.title,
            description: body.description ?? null,
            ownerUserId: body.ownerUserId ?? null,
            targetDate: body.targetDate ?? null,
        });
        return NextResponse.json({ initiative: created });
    }),
);
