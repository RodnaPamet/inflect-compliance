/**
 * ORG_OWNER, deploy 1 of 2 (#4576): every READER handles the value, and
 * nothing WRITES it.
 *
 * Owners are written here directly, the way deploy 2's backfill will write
 * them, because in this deploy no product path can. Against those rows:
 *
 *   - an owner holds exactly what an admin holds;
 *   - the member list puts the owner first;
 *   - a tenant created under the org is provisioned to the owner as to an admin;
 *   - an ORG_ADMIN can neither remove nor re-role an owner — refused, and the
 *     refusal is on the org's chain as ORG_AUTHZ_DENIED;
 *   - an owner cannot demote or remove the LAST owner;
 *   - owner → admin moves the role and no tenant access; owner → reader fans in;
 *   - the last-administrator guard counts the owner, so an admin beside an
 *     owner is no longer "the last admin";
 *   - no writer accepts ORG_OWNER: the direct add, the role change, the invite.
 */
import { PrismaClient, type OrgRole } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import { getOrgPermissions } from '@/lib/permissions';
import {
    addOrgMember,
    changeOrgMemberRole,
    listOrgMembers,
    removeOrgMember,
} from '@/app-layer/usecases/org-members';
import { createOrgInviteToken } from '@/app-layer/usecases/org-invites';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const ORG_SLUG = `owner-r-${SUITE}`;
let orgId = '';
const ids: Record<'owner' | 'owner2' | 'admin' | 'admin2' | 'reader', string> = {
    owner: '',
    owner2: '',
    admin: '',
    admin2: '',
    reader: '',
};
const tenantIds: string[] = [];

function ctxAs(who: keyof typeof ids, role: OrgRole): OrgContext {
    return {
        requestId: `req-${who}`,
        userId: ids[who],
        organizationId: orgId,
        orgSlug: ORG_SLUG,
        orgRole: role,
        permissions: getOrgPermissions(role),
    };
}

const roleOf = async (who: keyof typeof ids) =>
    (await prisma.orgMembership.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: ids[who] } },
        select: { role: true },
    }))?.role ?? null;
const tenantRole = async (who: keyof typeof ids) =>
    (await prisma.tenantMembership.findFirst({
        where: { tenantId: tenantIds[0], userId: ids[who] },
        select: { role: true },
    }))?.role ?? null;
const denials = () =>
    prisma.orgAuditLog.count({ where: { organizationId: orgId, action: 'ORG_AUTHZ_DENIED' } });

beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: ORG_SLUG, slug: ORG_SLUG } });
    orgId = org.id;
    for (const who of Object.keys(ids) as Array<keyof typeof ids>) {
        const user = await prisma.user.create({ data: { email: `${who}-${SUITE}@example.com`, name: who } });
        ids[who] = user.id;
    }
    // The owner joined first: deploy 2's backfill would pick exactly this row.
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    const rows: Array<[keyof typeof ids, OrgRole, number]> = [
        ['owner', 'ORG_OWNER', 0],
        ['admin', 'ORG_ADMIN', 1],
        ['reader', 'ORG_READER', 2],
    ];
    for (const [who, role, n] of rows) {
        await prisma.orgMembership.create({
            data: { organizationId: orgId, userId: ids[who], role, createdAt: at(n) },
        });
    }
});

afterAll(async () => {
    await prisma.$transaction(async (tx) => {
        // Tenant memberships past the tenant last-OWNER trigger, as the role
        // change suite does.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    });
    await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await deleteAuditRowsForTenants(prisma, tenantIds);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    // The organization, not its memberships: deploy 2's last-owner trigger
    // refuses deleting an org's last owner and lets the organization's own
    // cascade through.
    await deleteOrgAuditRowsForOrganizations(prisma, [orgId]);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    const users = Object.values(ids).filter(Boolean);
    await deleteAuditRowsForUsers(prisma, users);
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
});

describe('an owner is read as at least an admin', () => {
    it('holds everything an admin holds (deploy 2 adds the owner-only powers on top)', () => {
        const owner = getOrgPermissions('ORG_OWNER') as unknown as Record<string, boolean>;
        for (const [flag, granted] of Object.entries(getOrgPermissions('ORG_ADMIN'))) {
            if (granted) expect({ flag, owner: owner[flag] }).toEqual({ flag, owner: true });
        }
    });

    it('the member list puts the owner first', async () => {
        const rows = await listOrgMembers(ctxAs('admin', 'ORG_ADMIN'));
        expect(rows.map((r) => r.role)).toEqual(['ORG_OWNER', 'ORG_ADMIN', 'ORG_READER']);
    });

    it('a tenant created under the org is provisioned to every administrator', async () => {
        // Tenant management is the owner's since deploy 2.
        const r = await createTenantUnderOrg(ctxAs('owner', 'ORG_OWNER'), {
            name: `${ORG_SLUG} tenant`,
            slug: `${ORG_SLUG}-tenant`,
        });
        tenantIds.push(r.tenant.id);
        // The owner created it, so owns it; the other administrator is
        // provisioned ADMIN, and the reader nothing.
        expect(await tenantRole('owner')).toBe('OWNER');
        expect(await tenantRole('admin')).toBe('ADMIN');
        expect(await tenantRole('reader')).toBeNull();
    });
});

describe('an owner\'s membership is changed only by an owner', () => {
    it('an ORG_ADMIN cannot remove the owner: refused, audited, untouched', async () => {
        const before = await denials();
        await expect(removeOrgMember(ctxAs('admin', 'ORG_ADMIN'), { userId: ids.owner })).rejects.toThrow(
            /owner's membership/,
        );
        expect(await denials()).toBe(before + 1);
        expect(await roleOf('owner')).toBe('ORG_OWNER');
        expect(await tenantRole('owner')).toBe('OWNER');
    });

    it('an ORG_ADMIN cannot re-role the owner', async () => {
        const before = await denials();
        await expect(
            changeOrgMemberRole(ctxAs('admin', 'ORG_ADMIN'), { userId: ids.owner, role: 'ORG_READER' }),
        ).rejects.toThrow(/owner's membership/);
        expect(await denials()).toBe(before + 1);
        expect(await roleOf('owner')).toBe('ORG_OWNER');
    });

    it('an owner cannot demote or remove the LAST owner', async () => {
        // The second owner is the actor, not a member yet: the org has one owner.
        await expect(
            changeOrgMemberRole(ctxAs('owner2', 'ORG_OWNER'), { userId: ids.owner, role: 'ORG_ADMIN' }),
        ).rejects.toThrow(/last ORG_OWNER/);
        await expect(removeOrgMember(ctxAs('owner2', 'ORG_OWNER'), { userId: ids.owner })).rejects.toThrow(
            /last ORG_OWNER/,
        );
        expect(await roleOf('owner')).toBe('ORG_OWNER');
    });
});

describe('with a second owner, an owner may step down', () => {
    beforeAll(async () => {
        await prisma.orgMembership.create({ data: { organizationId: orgId, userId: ids.owner2, role: 'ORG_OWNER' } });
    });

    it('owner → admin moves the role and no tenant access', async () => {
        const r = await changeOrgMemberRole(ctxAs('owner2', 'ORG_OWNER'), { userId: ids.owner, role: 'ORG_ADMIN' });
        expect(r.transition).toBe('owner_to_admin');
        expect(r.provision).toBeUndefined();
        expect(r.deprovision).toBeUndefined();
        expect(await roleOf('owner')).toBe('ORG_ADMIN');
        expect(await tenantRole('owner')).toBe('OWNER');
    });
});

describe('the last-administrator guard counts an owner', () => {
    it('an admin beside an owner is not the last administrator', async () => {
        // owner2 is the owner now; admin and the former owner are admins.
        const r = await changeOrgMemberRole(ctxAs('owner2', 'ORG_OWNER'), { userId: ids.admin, role: 'ORG_READER' });
        expect(r.transition).toBe('admin_to_reader');
        expect(await roleOf('admin')).toBe('ORG_READER');
        const r2 = await removeOrgMember(ctxAs('owner2', 'ORG_OWNER'), { userId: ids.owner });
        expect(r2.wasOrgAdmin).toBe(true);
        // owner2 alone administers the org now, and is the last owner too.
        await expect(removeOrgMember(ctxAs('admin2', 'ORG_OWNER'), { userId: ids.owner2 })).rejects.toThrow(
            /last ORG_OWNER/,
        );
    });
});

// The role change became its ONE writer in deploy 2; see org-owner-writers.
describe('the direct add and the invite never write ORG_OWNER', () => {
    it('the direct add refuses it', async () => {
        await expect(
            addOrgMember(ctxAs('owner2', 'ORG_OWNER'), { userEmail: `new-${SUITE}@example.com`, role: 'ORG_OWNER' }),
        ).rejects.toThrow(/must be ORG_ADMIN or ORG_READER/);
    });

    it('the invite refuses it', async () => {
        await expect(
            createOrgInviteToken(ctxAs('owner2', 'ORG_OWNER'), { email: `inv-${SUITE}@example.com`, role: 'ORG_OWNER' }),
        ).rejects.toThrow();
        expect(await prisma.orgInvite.count({ where: { organizationId: orgId } })).toBe(0);
    });
});
