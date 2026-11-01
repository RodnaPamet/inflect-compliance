/**
 * GET /api/org/[orgSlug]/initiatives/link-candidates?tenantId=&type=&q=
 *
 * Items an initiative can link to (#4852): controls, risks, tasks or
 * findings in one of the organization's workspaces whose name matches `q`.
 * The initiative page's Link work picker reads it. Gated like every other
 * initiative write (`canConfigureDashboard`), because only someone who can
 * link work needs to search for it.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { badRequest } from '@/lib/errors/types';
import { INITIATIVE_LINK_TYPES, searchLinkCandidates } from '@/app-layer/usecases/org-security-initiative';

const QuerySchema = z.object({
    tenantId: z.string().min(1),
    type: z.enum(INITIATIVE_LINK_TYPES),
    q: z.string().max(200).optional(),
});

export const GET = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canConfigureDashboard', async (req, _args, ctx) => {
        const sp = req.nextUrl.searchParams;
        const parsed = QuerySchema.safeParse({
            tenantId: sp.get('tenantId') ?? '',
            type: sp.get('type') ?? '',
            q: sp.get('q') ?? undefined,
        });
        if (!parsed.success) throw badRequest('tenantId and a valid type are required.');
        const candidates = await searchLinkCandidates(ctx, {
            tenantId: parsed.data.tenantId,
            entityType: parsed.data.type,
            q: parsed.data.q ?? '',
        });
        return NextResponse.json({ candidates });
    }),
);
