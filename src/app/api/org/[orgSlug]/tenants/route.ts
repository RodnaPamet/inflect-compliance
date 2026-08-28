/**
 * Epic O-2 — tenants under an organization.
 *
 *   POST /api/org/[orgSlug]/tenants
 *     create a new tenant inside the org. Caller must be ORG_ADMIN
 *     (canManageTenants). Creator becomes OWNER of the new tenant.
 *     `provisionAllOrgAdminsToTenant` fans ADMIN rows to the OTHER
 *     ORG_ADMINs (the creator already has OWNER, which the
 *     unique constraint preserves).
 *
 *   GET /api/org/[orgSlug]/tenants
 *     list every tenant under the org. Any org member can read.
 */
import { NextRequest, NextResponse } from 'next/server';

import prisma from '@/lib/prisma';
import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateOrgTenantInput } from '@/app-layer/schemas/organization.schemas';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

export const POST = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canManageTenants', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, CreateOrgTenantInput);

        const result = await createTenantUnderOrg(ctx, {
            name: body.name,
            slug: body.slug,
        });

        return NextResponse.json(
            {
                tenant: result.tenant,
                provisionedAdmins: result.provisionedAdmins,
            },
            { status: 201 },
        );
    }),
);

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);

        const tenants = await prisma.tenant.findMany({
            // Exclude soft-deleted (org-removed) tenants.
            where: { organizationId: ctx.organizationId, deletedAt: null },
            select: {
                id: true,
                slug: true,
                name: true,
                industry: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'asc' },
        });

        return NextResponse.json({ tenants });
    },
);
