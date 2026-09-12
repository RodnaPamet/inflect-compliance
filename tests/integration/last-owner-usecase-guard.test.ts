/**
 * Integration tests for usecase-layer last-OWNER guard (Epic 1, PR 4).
 *
 * Verifies the user-friendly checks in `updateTenantMemberRole` and
 * `deactivateTenantMember` that sit in front of the DB trigger backstop.
 *
 * Covers:
 *   - Demoting the only OWNER → friendly forbidden
 *   - Deactivating the only OWNER → friendly forbidden
 *   - Non-OWNER promoting to OWNER → friendly forbidden
 *   - Non-OWNER demoting an OWNER → friendly forbidden
 *   - Second OWNER present → demotion allowed (happy path)
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import { updateTenantMemberRole, deactivateTenantMember, removeTenantMember } from '@/app-layer/usecases/tenant-admin';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('usecase-layer last-OWNER guard', () => {
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
                await prisma.tenantInvite.deleteMany({ where: { tenantId: { in: ids } } });
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
        const slug = `uc-owner-guard-${suffix}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }

    function emailFor(suffix: string): string {
        const email = `uc-owner-guard-${suffix}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }

    async function setupTenantWithOwner(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `UC Owner Guard ${suffix}`,
            slug,
            ownerEmail,
            requestId: `req-${suffix}`,
        });

        const ownerMembership = await prisma.tenantMembership.findFirst({
            where: { tenantId: result.tenant.id, role: 'OWNER', status: 'ACTIVE' },
            select: { id: true },
        });

        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });

        return {
            tenantId: result.tenant.id,
            slug,
            ownerEmail,
            ownerUserId: result.ownerUserId,
            ownerMembershipId: ownerMembership!.id,
            ownerCtx,
        };
    }

    async function addMember(tenantId: string, slug: string, suffix: string, role: 'ADMIN' | 'EDITOR') {
        const email = emailFor(suffix);
        const user = await prisma.user.create({
            data: { email, name: email.split('@')[0] },
            select: { id: true },
        });
        userEmails.push(email); // already tracked via emailFor
        const membership = await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role, status: 'ACTIVE' },
            select: { id: true },
        });
        const ctx = makeRequestContext(role, {
            userId: user.id,
            tenantId,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole(role),
        });
        return { userId: user.id, membershipId: membership.id, ctx };
    }

    // ── 1. Demoting the only OWNER ──────────────────────────────────────

    it('1. updateTenantMemberRole: demoting the only OWNER throws forbidden', async () => {
        const { ownerCtx, ownerMembershipId } = await setupTenantWithOwner('demote-last');

        await expect(
            updateTenantMemberRole(ownerCtx, {
                membershipId: ownerMembershipId,
                role: 'ADMIN',
            }),
        ).rejects.toThrow(/last OWNER/);
    });

    // ── 2. Deactivating the only OWNER ────────────────────────────────

    it('2. deactivateTenantMember: deactivating the only OWNER throws forbidden', async () => {
        const { tenantId, slug, ownerMembershipId } =
            await setupTenantWithOwner('deactivate-last');

        // Call as a second ADMIN (self-deactivation guard would fire
        // if we used ownerCtx). The assertion target is the last-OWNER
        // count guard, which must reject before the mutation lands.
        const admin = await addMember(tenantId, slug, 'admin-for-deactivate', 'ADMIN');

        await expect(
            deactivateTenantMember(admin.ctx, {
                membershipId: ownerMembershipId,
            }),
        ).rejects.toThrow(/last OWNER/);
    });

    // ── 2b. Removing (hard-delete) the only OWNER ─────────────────────

    it('2b. removeTenantMember: removing the only OWNER throws forbidden', async () => {
        const { tenantId, slug, ownerMembershipId } =
            await setupTenantWithOwner('remove-last');

        // Call as a second ADMIN (self-removal guard would fire on ownerCtx).
        const admin = await addMember(tenantId, slug, 'admin-for-remove', 'ADMIN');

        await expect(
            removeTenantMember(admin.ctx, {
                membershipId: ownerMembershipId,
            }),
        ).rejects.toThrow(/last OWNER/);
    });

    // ── 3. Non-OWNER trying to promote to OWNER ────────────────────────

    it('3. updateTenantMemberRole: ADMIN cannot promote a member to OWNER', async () => {
        const { tenantId, slug } = await setupTenantWithOwner('non-owner-promote');
        const admin = await addMember(tenantId, slug, 'admin-promote', 'ADMIN');
        const editor = await addMember(tenantId, slug, 'editor-promote', 'EDITOR');

        await expect(
            updateTenantMemberRole(admin.ctx, {
                membershipId: editor.membershipId,
                role: 'OWNER',
            }),
        ).rejects.toThrow(/Only OWNERs can promote/);
    });

    // ── 4. Non-OWNER trying to modify an OWNER's membership ───────────

    it('4. updateTenantMemberRole: ADMIN cannot demote an OWNER', async () => {
        const { tenantId, slug, ownerMembershipId } = await setupTenantWithOwner('non-owner-demote');
        const admin = await addMember(tenantId, slug, 'admin-demote', 'ADMIN');

        await expect(
            updateTenantMemberRole(admin.ctx, {
                membershipId: ownerMembershipId,
                role: 'ADMIN',
            }),
        ).rejects.toThrow(/Only OWNERs can modify/);
    });

    // ── 5. Happy path: second OWNER present → demotion allowed ─────────

    it('5. updateTenantMemberRole: can demote OWNER when a second OWNER exists', async () => {
        const { tenantId, ownerCtx, ownerMembershipId } =
            await setupTenantWithOwner('two-owners');

        // Add second OWNER directly (bypass usecase to avoid circular permission check).
        const email2 = emailFor('owner2-two');
        const user2 = await prisma.user.create({
            data: { email: email2, name: 'Owner Two' },
            select: { id: true },
        });
        await prisma.tenantMembership.create({
            data: { tenantId, userId: user2.id, role: 'OWNER', status: 'ACTIVE' },
        });

        // Demoting the first OWNER should now succeed.
        const updated = await updateTenantMemberRole(ownerCtx, {
            membershipId: ownerMembershipId,
            role: 'ADMIN',
        });

        expect(updated.role).toBe('ADMIN');
    });

    // ── 6. Happy path: removing a non-OWNER member succeeds ───────────
    //     Regression guard — the audit write inside removeTenantMember must
    //     use a valid AuditDetailsJsonSchema category (a bad category threw
    //     "Invalid detailsJson structure" → 400 in prod).

    it('6. removeTenantMember: hard-removes a non-OWNER member (audit write valid)', async () => {
        const { tenantId, slug } = await setupTenantWithOwner('remove-happy');
        const admin = await addMember(tenantId, slug, 'admin-remover', 'ADMIN');
        const editor = await addMember(tenantId, slug, 'editor-removed', 'EDITOR');

        await removeTenantMember(admin.ctx, { membershipId: editor.membershipId });

        const gone = await prisma.tenantMembership.findFirst({
            where: { id: editor.membershipId },
        });
        expect(gone).toBeNull();
    });
});
