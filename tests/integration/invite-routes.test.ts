/**
 * HTTP-layer tests for the invite routes (Epic 1, PR 3).
 *
 * These tests cover the route handlers by calling the usecase functions
 * directly with mocked dependencies, mirroring the pattern established
 * in tests/integration/tenant-admin.test.ts.
 *
 * For full end-to-end coverage (actual HTTP requests through Next.js)
 * see invite-redemption.test.ts which hits a real DB.
 */

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient } from '@prisma/client';

import {
    createInviteToken,
    revokeInvite,
    listPendingInvites,
    previewInviteByToken,
    redeemInvite,
} from '@/app-layer/usecases/tenant-invites';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('invite routes — usecase-level HTTP contract', () => {
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

    function slugFor(s: string) {
        const slug = `irt-test-${s}-${Date.now()}`;
        tenantSlugs.push(slug);
        return slug;
    }
    function emailFor(s: string) {
        const email = `irt-test-${s}-${Date.now()}@example.com`;
        userEmails.push(email);
        return email;
    }
    async function setupTenant(suffix: string) {
        const slug = slugFor(suffix);
        const ownerEmail = emailFor(`owner-${suffix}`);
        const result = await createTenantWithOwner({
            name: `IRT Tenant ${suffix}`,
            slug,
            ownerEmail,
            requestId: `irt-req-${suffix}`,
        });
        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, slug, ownerCtx };
    }
    async function createUser(email: string) {
        return prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, name: email.split('@')[0] },
            update: {},
        });
    }

    // ── POST /api/t/:slug/admin/invites — ADMIN creates invite (201) ───

    it('POST invites as ADMIN → invite row created, url returned', async () => {
        const { tenantId, ownerCtx } = await setupTenant('post');
        const targetEmail = emailFor('target-post');

        const result = await createInviteToken(ownerCtx, {
            email: targetEmail,
            role: 'EDITOR',
        });

        expect(result.invite.tenantId).toBe(tenantId);
        expect(result.invite.email).toBe(targetEmail);
        expect(result.invite.role).toBe('EDITOR');
        expect(result.invite.acceptedAt).toBeNull();
        expect(result.url).toMatch(/^\/invite\//);
    });

    // ── GET /api/invites/:token as wrong email → matchesSession: false ─

    it('GET preview as wrong session email → matchesSession false', async () => {
        const { ownerCtx } = await setupTenant('preview-mismatch');
        const targetEmail = emailFor('target-pm');
        const { invite } = await createInviteToken(ownerCtx, { email: targetEmail, role: 'AUDITOR' });

        const preview = await previewInviteByToken(invite.token, 'other@example.com');
        expect(preview).not.toBeNull();
        expect(preview!.matchesSession).toBe(false);
    });

    // ── POST /api/invites/:token as wrong email → 403 ─────────────────

    it('POST redeem as wrong email → 403 ForbiddenError', async () => {
        const { ownerCtx } = await setupTenant('redeem-wrong');
        const targetEmail = emailFor('target-rw');
        const wrongUser = await createUser(emailFor('wrong-rw'));
        const { invite } = await createInviteToken(ownerCtx, { email: targetEmail, role: 'READER' });

        await expect(
            redeemInvite({
                token: invite.token,
                userId: wrongUser.id,
                userEmail: wrongUser.email!,
            }),
        ).rejects.toMatchObject({ status: 403 });
    });

    // ── POST /api/invites/:token as right email → 200 + tenant/role ───

    it('POST redeem as right email → tenantId + slug + role returned', async () => {
        const { tenantId, slug, ownerCtx } = await setupTenant('redeem-right');
        const targetEmail = emailFor('target-rr');
        const user = await createUser(targetEmail);
        const { invite } = await createInviteToken(ownerCtx, { email: targetEmail, role: 'AUDITOR' });

        const result = await redeemInvite({
            token: invite.token,
            userId: user.id,
            userEmail: targetEmail,
        });

        expect(result.tenantId).toBe(tenantId);
        expect(result.slug).toBe(slug);
        expect(result.role).toBe('AUDITOR');
    });

    // ── DELETE /api/t/:slug/admin/invites/:id → 204, then list → empty ─

    it('DELETE invite → revoked, subsequent listPendingInvites returns empty for that invite', async () => {
        const { ownerCtx } = await setupTenant('delete');
        const targetEmail = emailFor('target-del');
        const { invite } = await createInviteToken(ownerCtx, { email: targetEmail, role: 'READER' });

        await revokeInvite(ownerCtx, { inviteId: invite.id });

        const pending = await listPendingInvites(ownerCtx);
        const found = pending.find((i) => i.id === invite.id);
        expect(found).toBeUndefined();
    });
});
