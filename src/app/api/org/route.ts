/**
 * Epic O-2 — top-level organization routes.
 *
 *   POST /api/org   — create a new organization. Authenticated session
 *                     required. The creator becomes ORG_OWNER on the
 *                     new org. Auto-provisioning runs but is a no-op
 *                     because the new org has zero tenants yet.
 *
 *   GET  /api/org   — list every organization the current user is a
 *                     member of (any role). Returns the user's role
 *                     per org so the client can render correct
 *                     navigation.
 *
 * Self-service org creation is open to any authenticated user — the
 * creator just gets their own org with no privilege over anyone else's
 * tenants. A future iteration could platform-admin-gate this; the
 * standard `API_MUTATION_LIMIT` from `withApiErrorHandling` already
 * caps spam.
 */
import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { getSessionOrThrow } from '@/lib/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateOrganizationInput } from '@/app-layer/schemas/organization.schemas';
import { provisionOrgAdminToTenants } from '@/app-layer/usecases/org-provisioning';
import { seedDefaultOrgDashboard } from '@/app-layer/usecases/org-dashboard-presets';
import { ConflictError } from '@/lib/errors/types';

export const POST = withApiErrorHandling(
    withValidatedBody(CreateOrganizationInput, async (_req, _ctx, body) => {
        const session = await getSessionOrThrow();
        const slug = body.slug.trim().toLowerCase();
        const name = body.name.trim();

        let orgId = '';
        try {
            const created = await prisma.$transaction(async (tx) => {
                const org = await tx.organization.create({
                    data: { name, slug },
                    select: { id: true, name: true, slug: true },
                });
                // The creator OWNS the organization (#4576 deploy 2), so a new
                // organization is never born without an owner.
                await tx.orgMembership.create({
                    data: {
                        organizationId: org.id,
                        userId: session.userId,
                        role: 'ORG_OWNER',
                    },
                });
                // Epic 41 — seed the default dashboard preset inside
                // the org-creation transaction so a new org is born
                // with a useful out-of-the-box overview. Idempotent:
                // a re-run on an org that already has widgets is a
                // no-op, never duplicate. The freshly-created org
                // has zero widgets so this unconditionally inserts
                // the eight defaults.
                await seedDefaultOrgDashboard(tx, org.id);
                return org;
            });
            orgId = created.id;

            // No-op for a freshly-created org (no tenants yet) but
            // wired in for symmetry — re-runs and races handle correctly.
            await provisionOrgAdminToTenants(orgId, session.userId);

            return NextResponse.json(
                {
                    organization: created,
                    role: 'ORG_OWNER' as const,
                },
                { status: 201 },
            );
        } catch (err) {
            if (
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002'
            ) {
                throw new ConflictError(
                    `An organization with slug '${slug}' already exists`,
                );
            }
            throw err;
        }
    }),
);

export const GET = withApiErrorHandling(async () => {
    const session = await getSessionOrThrow();

    const memberships = await prisma.orgMembership.findMany({
        where: { userId: session.userId },
        select: {
            role: true,
            organization: {
                select: { id: true, slug: true, name: true, createdAt: true },
            },
        },
        orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({
        organizations: memberships.map((m) => ({
            id: m.organization.id,
            slug: m.organization.slug,
            name: m.organization.name,
            createdAt: m.organization.createdAt,
            role: m.role,
        })),
    });
});
