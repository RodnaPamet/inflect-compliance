/**
 * Tests for per-tenant role resolution (R-1, security-critical).
 *
 * A user who is ADMIN in tenant A and READER in tenant B MUST get:
 *   - role=ADMIN when a request targets tenant A
 *   - role=READER when a request targets tenant B
 *
 * The role is resolved in resolveTenantContext() which is called by
 * getTenantCtx() for every request handler. This test exercises
 * resolveTenantContext directly against a real DB.
 *
 * CRITICAL: This is a security invariant. A user who is ADMIN in their
 * own tenant must NOT carry that ADMIN claim into a tenant where they're
 * only a READER. The JWT backward-compat fields (tenantId/role) reflect
 * the OLDEST membership only. resolveTenantContext re-derives the role
 * from the DB for the SPECIFIC tenant in the URL.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { resolveTenantContext } from '@/lib/tenant-context';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('per-tenant role resolution (R-1, security-critical)', () => {
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
        const slug = `per-role-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }

    function emailFor(suffix: string): string {
        const email = `per-role-${suffix}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }

    async function createTenant(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `Per-Role Test ${suffix}`,
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

    /**
     * Core security assertion: user is ADMIN in tenantA, READER in tenantB.
     * Requests to each tenant must return the role matching THAT tenant.
     */
    it('resolves ADMIN role for tenant where user is ADMIN', async () => {
        const { tenantId: tenantAId, slug: slugA } = await createTenant('admin-a');
        const { tenantId: tenantBId } = await createTenant('reader-b');

        const multiEmail = emailFor('admin-a-reader-b');
        const user = await createUser(multiEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantAId, role: 'ADMIN', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantBId, role: 'READER', status: 'ACTIVE' },
        });

        const ctxA = await resolveTenantContext({ tenantSlug: slugA }, user.id);

        expect(ctxA.role).toBe('ADMIN');
        expect(ctxA.permissions.canAdmin).toBe(true);
        expect(ctxA.permissions.canWrite).toBe(true);
    });

    it('resolves READER role for tenant where user is READER (not ADMIN)', async () => {
        const { tenantId: tenantAId } = await createTenant('admin-a2');
        const { tenantId: tenantBId, slug: slugB } = await createTenant('reader-b2');

        const multiEmail = emailFor('admin-a2-reader-b2');
        const user = await createUser(multiEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantAId, role: 'ADMIN', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantBId, role: 'READER', status: 'ACTIVE' },
        });

        const ctxB = await resolveTenantContext({ tenantSlug: slugB }, user.id);

        // CRITICAL: Must be READER, NOT ADMIN — no bleed-over from tenant A.
        expect(ctxB.role).toBe('READER');
        expect(ctxB.permissions.canAdmin).toBe(false);
        expect(ctxB.permissions.canWrite).toBe(false);
        expect(ctxB.permissions.canRead).toBe(true);
    });

    it('resolves the correct role for OWNER in one tenant and AUDITOR in another', async () => {
        const { tenantId: tenantCId, slug: slugC } = await createTenant('owner-c');
        const { tenantId: tenantDId, slug: slugD } = await createTenant('auditor-d');

        const multiEmail = emailFor('owner-c-auditor-d');
        const user = await createUser(multiEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantCId, role: 'OWNER', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantDId, role: 'AUDITOR', status: 'ACTIVE' },
        });

        const ctxC = await resolveTenantContext({ tenantSlug: slugC }, user.id);
        const ctxD = await resolveTenantContext({ tenantSlug: slugD }, user.id);

        expect(ctxC.role).toBe('OWNER');
        expect(ctxC.permissions.canAdmin).toBe(true);

        expect(ctxD.role).toBe('AUDITOR');
        expect(ctxD.permissions.canAdmin).toBe(false);
        expect(ctxD.permissions.canAudit).toBe(true);
        expect(ctxD.permissions.canWrite).toBe(false);
    });

    it('throws FORBIDDEN when user is not a member of the target tenant', async () => {
        const { slug: slugE } = await createTenant('no-access-e');

        // A user with NO membership in tenant E
        const outsiderEmail = emailFor('outsider-e');
        const outsider = await createUser(outsiderEmail);

        await expect(
            resolveTenantContext({ tenantSlug: slugE }, outsider.id),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('throws FORBIDDEN for DEACTIVATED membership — ADMIN in A cannot access B as DEACTIVATED', async () => {
        const { tenantId: tenantFId, slug: slugF } = await createTenant('admin-f');
        const { tenantId: tenantGId, slug: slugG } = await createTenant('deact-g');

        const multiEmail = emailFor('admin-f-deact-g');
        const user = await createUser(multiEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantFId, role: 'ADMIN', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantGId, role: 'EDITOR', status: 'DEACTIVATED' },
        });

        // Tenant F works fine
        const ctxF = await resolveTenantContext({ tenantSlug: slugF }, user.id);
        expect(ctxF.role).toBe('ADMIN');

        // Tenant G must be FORBIDDEN (deactivated)
        await expect(
            resolveTenantContext({ tenantSlug: slugG }, user.id),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('resolves permissions correctly when same user has EDITOR role in two tenants', async () => {
        const { tenantId: tenantHId, slug: slugH } = await createTenant('editor-h');
        const { tenantId: tenantIId, slug: slugI } = await createTenant('editor-i');

        const multiEmail = emailFor('editor-h-i');
        const user = await createUser(multiEmail);

        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantHId, role: 'EDITOR', status: 'ACTIVE' },
        });
        await prisma.tenantMembership.create({
            data: { userId: user.id, tenantId: tenantIId, role: 'EDITOR', status: 'ACTIVE' },
        });

        const ctxH = await resolveTenantContext({ tenantSlug: slugH }, user.id);
        const ctxI = await resolveTenantContext({ tenantSlug: slugI }, user.id);

        expect(ctxH.role).toBe('EDITOR');
        expect(ctxH.permissions.canWrite).toBe(true);
        expect(ctxH.permissions.canAdmin).toBe(false);

        expect(ctxI.role).toBe('EDITOR');
        expect(ctxI.permissions.canWrite).toBe(true);
        expect(ctxI.permissions.canAdmin).toBe(false);
    });
});
