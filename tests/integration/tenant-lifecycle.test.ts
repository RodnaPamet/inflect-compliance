/**
 * Integration tests for `createTenantWithOwner` and `transferTenantOwnership`.
 *
 * Verifies: Tenant row + DEK, OWNER membership, TenantOnboarding row,
 * audit entries, idempotent find-or-create user, duplicate-slug rejection,
 * and the two-step ownership transfer.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { hashForLookup } from '@/lib/security/encryption';

// Must import after env skip is set (jest.setup.js sets SKIP_ENV_VALIDATION=1).
import {
    createTenantWithOwner,
    transferTenantOwnership,
} from '@/app-layer/usecases/tenant-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('tenant-lifecycle usecases', () => {
    let prisma: PrismaClient;
    const tenantSlugs: string[] = [];
    const userEmails: string[] = [];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        // Cleanup in FK-safe order.
        try {
            const tenants = await prisma.tenant.findMany({
                where: { slug: { in: tenantSlugs } },
                select: { id: true },
            });
            const ids = tenants.map((t) => t.id);
            if (ids.length > 0) {
                await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: ids } } });
                await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
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
        const slug = `lc-test-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }

    function emailFor(suffix: string): string {
        const email = `lc-test-${suffix}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }

    it('creates Tenant with encryptedDek set', async () => {
        const slug = slugFor('dek');
        const email = emailFor('dek');
        const result = await createTenantWithOwner({
            name: 'DEK test tenant',
            slug,
            ownerEmail: email,
            requestId: 'test-req-dek',
        });

        const tenant = await prisma.tenant.findUnique({
            where: { id: result.tenant.id },
            select: { encryptedDek: true },
        });
        expect(tenant?.encryptedDek).toBeTruthy();
    });

    it('creates an ACTIVE OWNER membership for the owner email', async () => {
        const slug = slugFor('owner');
        const email = emailFor('owner');
        const result = await createTenantWithOwner({
            name: 'Owner membership test',
            slug,
            ownerEmail: email,
            requestId: 'test-req-owner',
        });

        const membership = await prisma.tenantMembership.findFirst({
            where: {
                tenantId: result.tenant.id,
                userId: result.ownerUserId,
            },
            select: { role: true, status: true },
        });
        expect(membership?.role).toBe('OWNER');
        expect(membership?.status).toBe('ACTIVE');
    });

    it('creates a TenantOnboarding row', async () => {
        const slug = slugFor('onboarding');
        const email = emailFor('onboarding');
        const result = await createTenantWithOwner({
            name: 'Onboarding test tenant',
            slug,
            ownerEmail: email,
            requestId: 'test-req-onboarding',
        });

        const onboarding = await prisma.tenantOnboarding.findUnique({
            where: { tenantId: result.tenant.id },
        });
        expect(onboarding).not.toBeNull();
    });

    it('writes two audit entries: TENANT_CREATED and TENANT_MEMBERSHIP_GRANTED', async () => {
        const slug = slugFor('audit');
        const email = emailFor('audit');
        const result = await createTenantWithOwner({
            name: 'Audit entry test tenant',
            slug,
            ownerEmail: email,
            requestId: 'test-req-audit',
        });

        const auditEntries = await prisma.auditLog.findMany({
            where: { tenantId: result.tenant.id },
            select: { action: true },
            orderBy: { createdAt: 'asc' },
        });

        const actions = auditEntries.map((e) => e.action);
        expect(actions).toContain('TENANT_CREATED');
        expect(actions).toContain('TENANT_MEMBERSHIP_GRANTED');
    });

    it('reuses an existing User when ownerEmail already exists', async () => {
        const slug1 = slugFor('reuse-a');
        const slug2 = slugFor('reuse-b');
        const email = emailFor('reuse');

        const r1 = await createTenantWithOwner({
            name: 'Reuse user A',
            slug: slug1,
            ownerEmail: email,
            requestId: 'test-req-reuse-a',
        });
        const r2 = await createTenantWithOwner({
            name: 'Reuse user B',
            slug: slug2,
            ownerEmail: email,
            requestId: 'test-req-reuse-b',
        });

        // Same userId — user was reused, not duplicated.
        expect(r1.ownerUserId).toBe(r2.ownerUserId);
    });

    it('rejects a duplicate slug with a Prisma conflict error', async () => {
        const slug = slugFor('dup');
        const email1 = emailFor('dup-1');
        const email2 = emailFor('dup-2');

        await createTenantWithOwner({
            name: 'Dup slug first',
            slug,
            ownerEmail: email1,
            requestId: 'test-req-dup-1',
        });

        await expect(
            createTenantWithOwner({
                name: 'Dup slug second',
                slug,
                ownerEmail: email2,
                requestId: 'test-req-dup-2',
            }),
        ).rejects.toThrow();
    });

    it('transfers ownership: new member becomes OWNER, old OWNER becomes ADMIN', async () => {
        const slug = slugFor('transfer');
        const email1 = emailFor('transfer-owner');
        const email2 = emailFor('transfer-new');

        const r = await createTenantWithOwner({
            name: 'Transfer test tenant',
            slug,
            ownerEmail: email1,
            requestId: 'test-req-transfer',
        });

        // Add the new owner as an ADMIN first.
        const user2 = await prisma.user.upsert({
            where: { emailHash: hashForLookup(email2) },
            update: {},
            create: { email: email2 },
            select: { id: true },
        });
        userEmails.push(email2);
        await prisma.tenantMembership.create({
            data: {
                tenantId: r.tenant.id,
                userId: user2.id,
                role: 'ADMIN',
                status: 'ACTIVE',
            },
        });

        const transferResult = await transferTenantOwnership({
            tenantId: r.tenant.id,
            currentOwnerUserId: r.ownerUserId,
            newOwnerEmail: email2,
        });

        expect(transferResult.fromOwnerId).toBe(r.ownerUserId);
        expect(transferResult.toOwnerId).toBe(user2.id);

        const newOwnerMembership = await prisma.tenantMembership.findFirst({
            where: { tenantId: r.tenant.id, userId: user2.id },
            select: { role: true },
        });
        expect(newOwnerMembership?.role).toBe('OWNER');

        const oldOwnerMembership = await prisma.tenantMembership.findFirst({
            where: { tenantId: r.tenant.id, userId: r.ownerUserId },
            select: { role: true },
        });
        expect(oldOwnerMembership?.role).toBe('ADMIN');
    });

    it('rejects transferOwnership when the new owner is not a tenant member', async () => {
        const slug = slugFor('transfer-not-member');
        const email1 = emailFor('transfer-nm-owner');
        const email2 = emailFor('transfer-nm-stranger');

        const r = await createTenantWithOwner({
            name: 'Transfer not-member test',
            slug,
            ownerEmail: email1,
            requestId: 'test-req-transfer-nm',
        });

        // Create user2 but do NOT add them to the tenant.
        await prisma.user.upsert({
            where: { emailHash: hashForLookup(email2) },
            update: {},
            create: { email: email2 },
            select: { id: true },
        });
        userEmails.push(email2);

        await expect(
            transferTenantOwnership({
                tenantId: r.tenant.id,
                currentOwnerUserId: r.ownerUserId,
                newOwnerEmail: email2,
            }),
        ).rejects.toThrow(/active tenant member/);
    });
});
