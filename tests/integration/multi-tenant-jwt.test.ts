/**
 * Tests for the R-1 JWT membership-array shape.
 *
 * The jwt callback in src/auth.ts was updated to load ALL active memberships
 * and store them as token.memberships[]. These tests exercise the pure
 * membership-build logic that feeds into the JWT by working through the
 * DB directly (prisma.user.findUnique with the exact include shape used in
 * src/auth.ts), verifying:
 *
 *   - Two ACTIVE memberships → both appear, sorted by createdAt ASC.
 *   - DEACTIVATED/REMOVED memberships are excluded (status filter).
 *   - Zero memberships → empty array.
 *
 * We do NOT try to invoke the NextAuth jwt() callback directly — it has
 * framework-internal dependencies (cookies, edge runtime context) that make
 * full-stack testing impractical in Jest. Instead we extract and test the
 * data-access and shape logic in isolation against a real DB.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';
import type { Role } from '@prisma/client';
import { hashForLookup } from '@/lib/security/encryption';

// ─── Pure helper extracted from src/auth.ts jwt callback logic ───

/**
 * Mirrors the membership-build logic from src/auth.ts jwt callback.
 * Given a prisma client + user email, returns the memberships array
 * that would end up in token.memberships.
 */
async function buildMembershipsForUser(
    prisma: PrismaClient,
    email: string,
): Promise<Array<{ slug: string; role: Role; tenantId: string }>> {
    const dbUser = await prisma.user.findUnique({
        where: { emailHash: hashForLookup(email) },
        include: {
            tenantMemberships: {
                where: { status: 'ACTIVE' },
                orderBy: { createdAt: 'asc' },
                include: {
                    tenant: { select: { slug: true, id: true } },
                },
            },
        },
    });

    if (!dbUser) return [];

    return dbUser.tenantMemberships.map((m) => ({
        slug: m.tenant.slug,
        role: m.role,
        tenantId: m.tenantId,
    }));
}

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('R-1 multi-tenant JWT memberships array', () => {
    let prisma: PrismaClient;

    const tenantSlugs: string[] = [];
    const userEmails: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        try {
            const tenants = await prisma.tenant.findMany({
                where: { slug: { in: tenantSlugs } },
                select: { id: true },
            });
            const ids = tenants.map((t) => t.id);
            if (ids.length > 0) {
                await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: ids } } });
            }
        } catch { /* best effort */ }
        try {
            await prisma.tenant.deleteMany({ where: { slug: { in: tenantSlugs } } });
        } catch { /* best effort */ }
        try {
            await prisma.user.deleteMany({ where: { email: { in: userEmails } } });
        } catch { /* best effort */ }
        await prisma.$disconnect();
    });

    function slugFor(suffix: string): string {
        const slug = `r1-jwt-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }

    function emailFor(suffix: string): string {
        const email = `r1-jwt-${suffix}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }

    async function createTenant(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `R1 JWT Test ${suffix}`,
            slug,
            ownerEmail,
            requestId: `req-${suffix}`,
        });
        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, slug, ownerCtx, ownerEmail };
    }

    async function createUser(email: string) {
        return prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, name: email.split('@')[0] },
            update: {},
        });
    }

    it('1. user with two ACTIVE memberships — both appear in array', async () => {
        const { tenantId: tenantA, slug: slugA } = await createTenant('two-a');
        const { tenantId: tenantB, slug: slugB } = await createTenant('two-b');

        const userEmail = emailFor('two-member');
        const user = await createUser(userEmail);

        // Add user to both tenants as EDITOR. Insert with a small delay so
        // createdAt ordering is deterministic.
        await prisma.tenantMembership.create({
            data: {
                userId: user.id,
                tenantId: tenantA,
                role: 'EDITOR',
                status: 'ACTIVE',
                createdAt: new Date(Date.now() - 1000), // older → first
            },
        });
        await prisma.tenantMembership.create({
            data: {
                userId: user.id,
                tenantId: tenantB,
                role: 'READER',
                status: 'ACTIVE',
                createdAt: new Date(), // newer → second
            },
        });

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(2);
        expect(memberships[0].slug).toBe(slugA);
        expect(memberships[0].role).toBe('EDITOR');
        expect(memberships[1].slug).toBe(slugB);
        expect(memberships[1].role).toBe('READER');
    });

    it('2. memberships are sorted by createdAt ASC', async () => {
        const { tenantId: tenantC, slug: slugC } = await createTenant('order-c');
        const { tenantId: tenantD, slug: slugD } = await createTenant('order-d');

        const userEmail = emailFor('order-user');
        const user = await createUser(userEmail);

        const earlier = new Date(Date.now() - 5000);
        const later = new Date();

        // Insert in reverse order (D first, then C) to prove ordering
        // is by createdAt, not insertion order.
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantD, role: 'READER', status: 'ACTIVE', createdAt: later },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantC, role: 'ADMIN', status: 'ACTIVE', createdAt: earlier },
        });

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(2);
        // C has earlier createdAt → should be first
        expect(memberships[0].slug).toBe(slugC);
        expect(memberships[1].slug).toBe(slugD);
    });

    it('3. DEACTIVATED memberships are excluded from the array', async () => {
        const { tenantId: tenantE, slug: slugE } = await createTenant('deact-e');
        const { tenantId: tenantF } = await createTenant('deact-f');

        const userEmail = emailFor('deact-user');
        const user = await createUser(userEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantE, role: 'EDITOR', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantF, role: 'READER', status: 'DEACTIVATED' },
        });

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(1);
        expect(memberships[0].slug).toBe(slugE);
    });

    it('4. REMOVED memberships are excluded from the array', async () => {
        const { tenantId: tenantG, slug: slugG } = await createTenant('removed-g');
        const { tenantId: tenantH } = await createTenant('removed-h');

        const userEmail = emailFor('removed-user');
        const user = await createUser(userEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantG, role: 'READER', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantH, role: 'EDITOR', status: 'REMOVED' },
        });

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(1);
        expect(memberships[0].slug).toBe(slugG);
    });

    it('5. user with zero memberships → empty array', async () => {
        const userEmail = emailFor('no-memberships');
        await createUser(userEmail);

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(0);
    });

    it('6. memberships array contains correct tenantId per entry', async () => {
        const { tenantId: expectedTenantId, slug } = await createTenant('tenant-id-check');

        const userEmail = emailFor('tid-user');
        const user = await createUser(userEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: expectedTenantId, role: 'EDITOR', status: 'ACTIVE' },
        });

        const memberships = await buildMembershipsForUser(prisma, userEmail);

        expect(memberships).toHaveLength(1);
        expect(memberships[0].tenantId).toBe(expectedTenantId);
        expect(memberships[0].slug).toBe(slug);
    });
});
