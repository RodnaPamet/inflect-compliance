/**
 * Epic O-2 — organization detail.
 *
 * GET /api/org/[orgSlug]
 *
 * Returns metadata + tenant count + member count for the org. Caller
 * must be a member (any role) — `getOrgCtx` enforces.
 *
 * The user's role + permission flags are returned alongside so the
 * client can render the correct navigation without re-deriving.
 */
import { NextRequest, NextResponse } from 'next/server';

import prisma from '@/lib/prisma';
import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);

        // Counts are fast against the indexed columns
        // (Tenant.organizationId, OrgMembership.organizationId).
        const [tenantCount, memberCount] = await Promise.all([
            prisma.tenant.count({
                // Soft-deleted (org-removed) tenants are not counted, as
                // GET /api/org/[orgSlug]/tenants does not list them (#5303).
                where: { organizationId: ctx.organizationId, deletedAt: null },
            }),
            prisma.orgMembership.count({
                where: { organizationId: ctx.organizationId },
            }),
        ]);

        const org = await prisma.organization.findUnique({
            where: { id: ctx.organizationId },
            select: { id: true, slug: true, name: true, createdAt: true, updatedAt: true },
        });

        return NextResponse.json({
            organization: org,
            counts: {
                tenants: tenantCount,
                members: memberCount,
            },
            role: ctx.orgRole,
            permissions: ctx.permissions,
        });
    },
);
