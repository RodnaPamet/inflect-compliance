/**
 * Integration coverage for the server-side org context resolver
 * (`src/lib/server/org-context.server.ts`).
 *
 * Exercises every branch of `getOrgServerContext`:
 *   - empty/whitespace slug → NotFoundError (no DB hit),
 *   - unknown org slug → NotFoundError (`org_not_found` log reason),
 *   - existing org but no membership → NotFoundError (`not_a_member`),
 *   - ORG_ADMIN member → full OrgPermissionSet,
 *   - ORG_READER member → portfolio-only OrgPermissionSet.
 *
 * The anti-enumeration policy means all four failure surfaces throw the
 * same generic message — we assert on that invariant too.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, OrgRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { getOrgServerContext } from '@/lib/server/org-context.server';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `org-ctx-${randomUUID().slice(0, 8)}`;
const ORG_SLUG = SUITE_TAG;

let orgId: string;
let adminUserId: string;
let readerUserId: string;
let strangerUserId: string;

async function makeUser(label: string): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return u.id;
}

describeFn('getOrgServerContext — org context resolution (integration)', () => {
    beforeAll(async () => {
        const org = await globalPrisma.organization.create({
            data: { name: `org ${SUITE_TAG}`, slug: ORG_SLUG },
        });
        orgId = org.id;

        adminUserId = await makeUser('admin');
        readerUserId = await makeUser('reader');
        strangerUserId = await makeUser('stranger');

        await globalPrisma.orgMembership.create({
            data: { organizationId: orgId, userId: adminUserId, role: OrgRole.ORG_ADMIN },
        });
        await globalPrisma.orgMembership.create({
            data: { organizationId: orgId, userId: readerUserId, role: OrgRole.ORG_READER },
        });
    });

    afterAll(async () => {
        // Guarded: an undefined filter value is DROPPED, not matched — see
        // the teardown note in ./db-helper.ts. `orgId` is assigned by the
        // FIRST statement of `beforeAll`, so every failure path leaves it
        // undefined here. Both lines read it, so one guard covers both.
        if (orgId) {
            await globalPrisma.orgMembership.deleteMany({ where: { organizationId: orgId } });
            await globalPrisma.organization.deleteMany({ where: { id: orgId } });
        }
        await globalPrisma.user.deleteMany({
            where: { id: { in: [adminUserId, readerUserId, strangerUserId] } },
        });
        await globalPrisma.$disconnect();
    });

    const GENERIC = /not found or access not permitted/i;

    it('rejects an empty / whitespace slug before any DB lookup', async () => {
        await expect(
            getOrgServerContext({ orgSlug: '', userId: adminUserId }),
        ).rejects.toThrow(GENERIC);
        await expect(
            getOrgServerContext({ orgSlug: '   ', userId: adminUserId }),
        ).rejects.toThrow(GENERIC);
    });

    it('rejects an unknown org slug with the generic message (org_not_found)', async () => {
        await expect(
            getOrgServerContext({ orgSlug: `no-such-${SUITE_TAG}`, userId: adminUserId }),
        ).rejects.toThrow(GENERIC);
    });

    it('rejects a non-member of an existing org with the same generic message (not_a_member)', async () => {
        await expect(
            getOrgServerContext({ orgSlug: ORG_SLUG, userId: strangerUserId }),
        ).rejects.toThrow(GENERIC);
    });

    it('returns full context + ORG_ADMIN permissions for an admin member', async () => {
        const ctx = await getOrgServerContext({ orgSlug: ORG_SLUG, userId: adminUserId });
        expect(ctx.organization).toEqual({ id: orgId, slug: ORG_SLUG, name: `org ${SUITE_TAG}` });
        expect(ctx.role).toBe('ORG_ADMIN');
        expect(ctx.permissions.canViewPortfolio).toBe(true);
        expect(ctx.permissions.canDrillDown).toBe(true);
        expect(ctx.permissions.canManageTenants).toBe(true);
        expect(ctx.permissions.canManageMembers).toBe(true);
    });

    it('returns portfolio-only ORG_READER permissions for a reader member', async () => {
        const ctx = await getOrgServerContext({ orgSlug: ORG_SLUG, userId: readerUserId });
        expect(ctx.role).toBe('ORG_READER');
        expect(ctx.permissions.canViewPortfolio).toBe(true);
        expect(ctx.permissions.canDrillDown).toBe(false);
        expect(ctx.permissions.canManageTenants).toBe(false);
        expect(ctx.permissions.canManageMembers).toBe(false);
    });

    it('tolerates surrounding whitespace in a valid slug (trim branch)', async () => {
        const ctx = await getOrgServerContext({ orgSlug: `  ${ORG_SLUG}  `, userId: adminUserId });
        expect(ctx.organization.slug).toBe(ORG_SLUG);
        expect(ctx.role).toBe('ORG_ADMIN');
    });
});
