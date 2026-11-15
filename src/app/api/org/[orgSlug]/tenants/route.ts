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
 *     list every tenant under the org. Any org member can read. Each row
 *     carries `isMember`: whether the CALLER holds an ACTIVE membership in
 *     that tenant, which is what opens it (#5309 item 16). An ORG_READER is
 *     provisioned nothing, so the switcher shows them only those rows.
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

        // One read for the caller's memberships across the listed tenants,
        // bounded by the list itself.
        const memberships = tenants.length === 0
            ? []
            : await prisma.tenantMembership.findMany({
                where: {
                    userId: ctx.userId,
                    status: 'ACTIVE',
                    tenantId: { in: tenants.map((t) => t.id) },
                },
                select: { tenantId: true },
                take: tenants.length,
            });
        const memberOf = new Set(memberships.map((m) => m.tenantId));

        return NextResponse.json({
            tenants: tenants.map((t) => ({ ...t, isMember: memberOf.has(t.id) })),
        });
    },
);
