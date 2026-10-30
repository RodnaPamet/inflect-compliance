/**
 * ORG_OWNER, deploy 2 of 2 (#4576): the writers, the backfill and the guard.
 *
 *   - THE BACKFILL: the migration's own UPDATE, read from the migration file
 *     and run inside a transaction that is rolled back, promotes the EARLIEST
 *     ORG_ADMIN of an organization with no owner, skips one that already has an
 *     owner, and gives none to an organization with no admin.
 *   - THE TRIGGER: a raw delete or demotion of an organization's last owner is
 *     refused (P0001) whatever the writer; with a second owner it goes through;
 *     deleting the ORGANIZATION still cascades.
 *   - THE ROLE CHANGE is the one writer that makes an owner, and only an owner
 *     may: an ORG_ADMIN is refused and audited; an owner's promotion of a reader
 *     fans ADMIN out to the org's tenants, of an admin moves the role alone.
 *   - TENANT MANAGEMENT is the owner's: an ORG_ADMIN is refused.
 *   - A NEW ORGANIZATION is owned by its creator (POST /api/org).
 */
const getSessionMock = jest.fn();
jest.mock('@/lib/auth', () => {
    const actual = jest.requireActual('@/lib/auth');
    return { __esModule: true, ...actual, getSessionOrThrow: (...a: unknown[]) => getSessionMock(...a) };
});

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, type OrgRole } from '@prisma/client';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import { getOrgPermissions } from '@/lib/permissions';
import { changeOrgMemberRole } from '@/app-layer/usecases/org-members';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import { POST as createOrg } from '@/app/api/org/route';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const userIds: string[] = [];
const orgIds: string[] = [];
const tenantIds: string[] = [];

async function user(label: string): Promise<string> {
    const u = await prisma.user.create({ data: { email: `${label}-${SUITE}@example.com`, name: label } });
    userIds.push(u.id);
    return u.id;
}
async function org(label: string): Promise<string> {
    const o = await prisma.organization.create({ data: { name: label, slug: `${label}-${SUITE}` } });
    orgIds.push(o.id);
    return o.id;
}
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
async function member(organizationId: string, userId: string, role: OrgRole, minute = 0) {
    await prisma.orgMembership.create({ data: { organizationId, userId, role, createdAt: at(minute) } });
}
const roleIn = async (organizationId: string, userId: string) =>
    (await prisma.orgMembership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true },
    }))?.role ?? null;
function ctx(organizationId: string, userId: string, role: OrgRole): OrgContext {
    return {
        requestId: `req-${userId}`,
        userId,
        organizationId,
        orgSlug: 'x',
        orgRole: role,
        permissions: getOrgPermissions(role),
    };
}

/** The backfill statement, exactly as the migration ships it. */
function backfillSql(): string {
    const file = path.resolve(
        __dirname,
        '../../prisma/migrations/20261030160000_org_owner_backfill_and_guard/migration.sql',
    );
    const sql = fs.readFileSync(file, 'utf8');
    const start = sql.indexOf('UPDATE "OrgMembership" AS m');
    const end = sql.indexOf(';', start);
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start, end + 1);
}

afterAll(async () => {
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, tenantIds);
    });
    await prisma.tenantOnboarding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await deleteAuditRowsForTenants(prisma, tenantIds);
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.orgDashboardWidget.deleteMany({ where: { organizationId: { in: orgIds } } });
    await deleteOrgAuditRowsForOrganizations(prisma, orgIds);
    // The organizations, not their memberships: the trigger lets the cascade through.
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await deleteAuditRowsForUsers(prisma, userIds);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

describe('the backfill', () => {
    it('promotes the earliest ORG_ADMIN, skips an owned org, and owns no adminless org', async () => {
        const two = await org('bf-two-admins');
        const owned = await org('bf-owned');
        const readersOnly = await org('bf-readers');
        const [early, late, reader, owner, admin, lone] = await Promise.all(
            ['early', 'late', 'reader', 'owner', 'admin', 'lone'].map((l) => user(`bf-${l}`)),
        );
        await member(two, late, 'ORG_ADMIN', 5);
        await member(two, early, 'ORG_ADMIN', 1);
        await member(two, reader, 'ORG_READER', 0);
        await member(owned, owner, 'ORG_OWNER', 9);
        await member(owned, admin, 'ORG_ADMIN', 1);
        await member(readersOnly, lone, 'ORG_READER', 0);

        const seen = await prisma
            .$transaction(async (tx) => {
                await tx.$executeRawUnsafe(backfillSql());
                const rows = await tx.orgMembership.findMany({
                    where: { organizationId: { in: [two, owned, readersOnly] } },
                    select: { organizationId: true, userId: true, role: true },
                });
                throw Object.assign(new Error('rollback'), { rows });
            })
            .catch((e: { rows?: Array<{ organizationId: string; userId: string; role: OrgRole }> }) => e.rows ?? []);
        const role = (o: string, u: string) => seen.find((r) => r.organizationId === o && r.userId === u)?.role;

        expect(role(two, early)).toBe('ORG_OWNER');
        expect(role(two, late)).toBe('ORG_ADMIN');
        expect(role(two, reader)).toBe('ORG_READER');
        expect(role(owned, owner)).toBe('ORG_OWNER');
        expect(role(owned, admin)).toBe('ORG_ADMIN');
        expect(role(readersOnly, lone)).toBe('ORG_READER');
        // Rolled back: the shared database is untouched.
        expect(await roleIn(two, early)).toBe('ORG_ADMIN');
    });
});

describe('the last-owner trigger', () => {
    let o = '';
    let first = '';
    let second = '';
    beforeAll(async () => {
        o = await org('trg');
        first = await user('trg-first');
        second = await user('trg-second');
        await member(o, first, 'ORG_OWNER');
    });

    it('refuses deleting or demoting the last owner, whatever the writer', async () => {
        await expect(
            prisma.orgMembership.delete({ where: { organizationId_userId: { organizationId: o, userId: first } } }),
        ).rejects.toThrow(/LAST_ORG_OWNER_GUARD/);
        await expect(
            prisma.orgMembership.update({
                where: { organizationId_userId: { organizationId: o, userId: first } },
                data: { role: 'ORG_ADMIN' },
            }),
        ).rejects.toThrow(/LAST_ORG_OWNER_GUARD/);
        expect(await roleIn(o, first)).toBe('ORG_OWNER');
    });

    it('lets one of two owners go', async () => {
        await member(o, second, 'ORG_OWNER');
        await prisma.orgMembership.update({
            where: { organizationId_userId: { organizationId: o, userId: first } },
            data: { role: 'ORG_ADMIN' },
        });
        expect(await roleIn(o, first)).toBe('ORG_ADMIN');
    });

    it('lets the organization itself be deleted, its owner with it', async () => {
        const doomed = await org('trg-doomed');
        const sole = await user('trg-sole');
        await member(doomed, sole, 'ORG_OWNER');
        await prisma.organization.delete({ where: { id: doomed } });
        expect(await prisma.orgMembership.count({ where: { organizationId: doomed } })).toBe(0);
    });
});

describe('the role change is the one writer that makes an owner', () => {
    let o = '';
    const u: Record<'owner' | 'admin' | 'reader' | 'reader2', string> = { owner: '', admin: '', reader: '', reader2: '' };
    beforeAll(async () => {
        o = await org('rc');
        for (const k of Object.keys(u) as Array<keyof typeof u>) u[k] = await user(`rc-${k}`);
        await member(o, u.owner, 'ORG_OWNER');
        await member(o, u.admin, 'ORG_ADMIN');
        await member(o, u.reader, 'ORG_READER');
        await member(o, u.reader2, 'ORG_READER');
        const t = await createTenantUnderOrg(ctx(o, u.owner, 'ORG_OWNER'), { name: `rc-${SUITE}`, slug: `rc-t-${SUITE}` });
        tenantIds.push(t.tenant.id);
    });
    const tenantRole = async (userId: string) =>
        (await prisma.tenantMembership.findFirst({ where: { tenantId: tenantIds[0], userId }, select: { role: true } }))
            ?.role ?? null;

    it('an ORG_ADMIN cannot make an owner: refused and audited', async () => {
        const denials = () =>
            prisma.orgAuditLog.count({ where: { organizationId: o, action: 'ORG_AUTHZ_DENIED' } });
        const before = await denials();
        await expect(changeOrgMemberRole(ctx(o, u.admin, 'ORG_ADMIN'), { userId: u.reader, role: 'ORG_OWNER' })).rejects.toThrow(
            /owner's membership/,
        );
        expect(await denials()).toBe(before + 1);
        expect(await roleIn(o, u.reader)).toBe('ORG_READER');
    });

    it('an owner makes a reader an owner, which fans ADMIN out to the tenants', async () => {
        const r = await changeOrgMemberRole(ctx(o, u.owner, 'ORG_OWNER'), { userId: u.reader, role: 'ORG_OWNER' });
        expect(r.transition).toBe('reader_to_owner');
        expect(await roleIn(o, u.reader)).toBe('ORG_OWNER');
        expect(await tenantRole(u.reader)).toBe('ADMIN');
    });

    it('an owner makes an admin an owner, which moves the role alone', async () => {
        const r = await changeOrgMemberRole(ctx(o, u.owner, 'ORG_OWNER'), { userId: u.admin, role: 'ORG_OWNER' });
        expect(r.transition).toBe('admin_to_owner');
        expect(r.provision).toBeUndefined();
        expect(await tenantRole(u.admin)).toBe('ADMIN');
    });
});

describe('tenant management is the owner\'s', () => {
    it('an ORG_ADMIN cannot create a tenant under the organization', async () => {
        const o = await org('tm');
        const a = await user('tm-admin');
        await member(o, a, 'ORG_ADMIN');
        await expect(
            createTenantUnderOrg(ctx(o, a, 'ORG_ADMIN'), { name: `tm-${SUITE}`, slug: `tm-t-${SUITE}` }),
        ).rejects.toThrow();
        expect(await prisma.tenant.count({ where: { slug: `tm-t-${SUITE}` } })).toBe(0);
    });
});

describe('a new organization is owned by its creator', () => {
    it('POST /api/org writes the creator as ORG_OWNER', async () => {
        const creator = await user('creator');
        getSessionMock.mockResolvedValue({ userId: creator });
        const slug = `created-${SUITE}`;
        const res = await createOrg(
            new NextRequest('http://localhost/api/org', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Created', slug }),
            }),
            {} as never,
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { organization: { id: string }; role: string };
        orgIds.push(body.organization.id);
        expect(body.role).toBe('ORG_OWNER');
        expect(await roleIn(body.organization.id, creator)).toBe('ORG_OWNER');
    });
});
