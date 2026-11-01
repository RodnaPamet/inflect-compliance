/**
 * The JWT membership claims are re-read from the database, not frozen at
 * sign-in.
 *
 * These tests exist because of a defect that was visible in production and
 * invisible to every existing test: an ORG_ADMIN, standing on their own
 * organization's page, was told by the workspace switcher that they belonged to
 * "no organizations in this session". The org page rendered because it is
 * DB-gated server-side; the switcher reads only the token, and the token's
 * claims were minted at sign-in and never refreshed.
 *
 * The documented mitigation — `trigger: 'update'` — could not close it. The app
 * mounts no `<SessionProvider>`, and even the hand-rolled equivalent in
 * `NewTenantForm` only ever fires for a user acting on their own behalf. A
 * membership granted BY someone else (org auto-provisioning, an accepted
 * invite, an admin adding you to a tenant) arrives in a request the affected
 * user never makes, so no client-side refresh can reach it.
 *
 * `applyMembershipClaims` is now also called on the jwt callback's throttled
 * 5-minute check. These tests pin what that call actually does — they exercise
 * the REAL function from `src/auth.ts` rather than a copy of its query, so a
 * change to the include shape or the status filter fails here rather than
 * passing against a duplicate that drifted.
 */
import type { JWT } from 'next-auth/jwt';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { hashForLookup } from '@/lib/security/encryption';
import { applyMembershipClaims } from '@/auth';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('JWT membership claims refresh', () => {
    let prisma: PrismaClient;
    const stamp = () => `${Date.now()}-${Math.floor(process.hrtime()[1] / 1000)}`;

    beforeAll(async () => {
        prisma = prismaTestClient();
    });

    /** A token in the shape the jwt callback hands to the refresh. */
    function tokenFor(email: string): JWT {
        return { email } as unknown as JWT;
    }

    async function makeUser(email: string) {
        return prisma.user.upsert({
            where: { emailHash: hashForLookup(email) },
            create: { email, name: email.split('@')[0] },
            update: {},
        });
    }

    it('picks up a tenant membership granted AFTER the token was minted', async () => {
        const s = stamp();
        const email = `claims-tenant-${s}@example.com`;
        const user = await makeUser(email);

        // Mint once with nothing — this is the sign-in state.
        const token = tokenFor(email);
        await applyMembershipClaims(token);
        expect(token.memberships).toStrictEqual([]);

        // Someone else grants the membership. The user makes no request.
        const created = await createTenantWithOwner({
            name: `Claims Refresh ${s}`,
            slug: `claims-refresh-${s}`.slice(0, 40),
            ownerEmail: `owner-${s}@example.com`,
            requestId: `req-${s}`,
        });
        await prisma.tenantMembership.create({
            data: {
                userId: user.id,
                tenantId: created.tenant.id,
                role: 'EDITOR',
                status: 'ACTIVE',
            },
        });

        // The refresh the throttled check now performs.
        await applyMembershipClaims(token);

        expect(token.memberships).toHaveLength(1);
        expect(token.memberships?.[0]).toMatchObject({
            tenantId: created.tenant.id,
            role: 'EDITOR',
        });
    });

    it('picks up an ORG membership granted after sign-in — the reported defect', async () => {
        const s = stamp();
        const email = `claims-org-${s}@example.com`;
        const user = await makeUser(email);

        const token = tokenFor(email);
        await applyMembershipClaims(token);
        // This empty array is exactly what rendered "No organizations in this
        // session" for a user who was, in the database, an ORG_ADMIN.
        expect(token.orgMemberships).toStrictEqual([]);

        const org = await prisma.organization.create({
            data: { name: `Claims Org ${s}`, slug: `claims-org-${s}`.slice(0, 40) },
        });
        await prisma.orgMembership.create({
            data: { organizationId: org.id, userId: user.id, role: 'ORG_ADMIN' },
        });

        await applyMembershipClaims(token);

        expect(token.orgMemberships).toHaveLength(1);
        expect(token.orgMemberships?.[0]).toMatchObject({
            slug: org.slug,
            role: 'ORG_ADMIN',
            organizationId: org.id,
        });
    });

    it('SHRINKS the claims when a membership is revoked', async () => {
        const s = stamp();
        const email = `claims-revoke-${s}@example.com`;
        const user = await makeUser(email);

        const created = await createTenantWithOwner({
            name: `Claims Revoke ${s}`,
            slug: `claims-revoke-${s}`.slice(0, 40),
            ownerEmail: `owner-rev-${s}@example.com`,
            requestId: `req-rev-${s}`,
        });
        const membership = await prisma.tenantMembership.create({
            data: {
                userId: user.id,
                tenantId: created.tenant.id,
                role: 'EDITOR',
                status: 'ACTIVE',
            },
        });

        const token = tokenFor(email);
        await applyMembershipClaims(token);
        expect(token.memberships).toHaveLength(1);

        // Before the periodic refresh existed, this membership stayed in the
        // token until re-login, so the Edge gate kept authorizing the slug.
        await prisma.tenantMembership.update({
            where: { id: membership.id },
            data: { status: 'REMOVED' },
        });

        await applyMembershipClaims(token);
        expect(token.memberships).toStrictEqual([]);
    });

    it('excludes a membership whose tenant was soft-deleted by the org', async () => {
        const s = stamp();
        const email = `claims-softdel-${s}@example.com`;
        const user = await makeUser(email);

        const created = await createTenantWithOwner({
            name: `Claims SoftDel ${s}`,
            slug: `claims-softdel-${s}`.slice(0, 40),
            ownerEmail: `owner-sd-${s}@example.com`,
            requestId: `req-sd-${s}`,
        });
        await prisma.tenantMembership.create({
            data: {
                userId: user.id,
                tenantId: created.tenant.id,
                role: 'EDITOR',
                status: 'ACTIVE',
            },
        });

        const token = tokenFor(email);
        await applyMembershipClaims(token);
        expect(token.memberships).toHaveLength(1);

        await prisma.tenant.update({
            where: { id: created.tenant.id },
            data: { deletedAt: new Date() },
        });

        await applyMembershipClaims(token);
        expect(token.memberships).toStrictEqual([]);
    });

    it('keeps a workspace the Entra group gate refused out of the claims on every re-read (#4869)', async () => {
        const s = stamp();
        const email = `claims-entra-${s}@example.com`;
        const user = await makeUser(email);

        const refused = await createTenantWithOwner({
            name: `Claims Entra Refused ${s}`,
            slug: `claims-entra-r-${s}`.slice(0, 40),
            ownerEmail: `owner-er-${s}@example.com`,
            requestId: `req-er-${s}`,
        });
        const kept = await createTenantWithOwner({
            name: `Claims Entra Kept ${s}`,
            slug: `claims-entra-k-${s}`.slice(0, 40),
            ownerEmail: `owner-ek-${s}@example.com`,
            requestId: `req-ek-${s}`,
        });
        for (const tenantId of [refused.tenant.id, kept.tenant.id]) {
            await prisma.tenantMembership.create({
                data: { userId: user.id, tenantId, role: 'EDITOR', status: 'ACTIVE' },
            });
        }

        // The membership is ACTIVE in both; only the session's refusal,
        // recorded at sign-in, can keep one out. Before #4869 the re-read put
        // it straight back.
        const token = tokenFor(email);
        token.entraGateDeniedTenantIds = [refused.tenant.id];
        await applyMembershipClaims(token);
        expect(token.memberships?.map((m) => m.tenantId)).toEqual([kept.tenant.id]);
        await applyMembershipClaims(token);
        expect(token.memberships?.map((m) => m.tenantId)).toEqual([kept.tenant.id]);

        // A session with no refusal holds both.
        const fresh = tokenFor(email);
        await applyMembershipClaims(fresh);
        expect(fresh.memberships?.map((m) => m.tenantId).sort()).toEqual([refused.tenant.id, kept.tenant.id].sort());
    });

    it('carries the display name and photo the profile page saved, and clears a removed photo (#4644)', async () => {
        const s = stamp();
        const email = `claims-profile-${s}@example.com`;
        const user = await makeUser(email);

        // Minted at sign-in with the provider's values.
        const token = { ...tokenFor(email), name: 'Old Name', picture: 'https://idp.example/old.png' } as JWT;

        // The profile page writes the row; the next refresh reads it.
        await prisma.user.update({
            where: { id: user.id },
            data: { name: 'Ada Lovelace', image: `/api/account/avatar/${user.id}` },
        });
        await applyMembershipClaims(token);
        expect(token.name).toBe('Ada Lovelace');
        expect(token.picture).toBe(`/api/account/avatar/${user.id}`);

        // Removing the photo is a NULL `image`; the token must not keep the old one.
        await prisma.user.update({ where: { id: user.id }, data: { image: null } });
        await applyMembershipClaims(token);
        expect(token.picture).toBeNull();
        expect(token.name).toBe('Ada Lovelace');
    });
});
