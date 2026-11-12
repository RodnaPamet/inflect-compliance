/**
 * #5373 — two org owners changing each other at once never leave an
 * organization with no owner, and a removal that does not go through takes
 * nobody's tenant access with it.
 *
 *   - THE TRIGGER, raw SQL with explicit ordering: transaction 1 demotes owner
 *     B and holds; transaction 2 demotes owner A. Without serialisation both
 *     counts see the other row still ORG_OWNER and both commit — zero owners.
 *     With it, transaction 2 waits on the per-organization lock and, once 1
 *     commits, its count sees the demotion and is refused (P0001).
 *   - THE USECASE: A demotes B while B demotes A, both started behind a held
 *     lock so each has passed its pre-transaction count. Exactly one succeeds;
 *     the other is refused LAST_ORG_OWNER; one owner remains.
 *   - THE REMOVAL: A removes B while A is being demoted. The fan-in of B's
 *     tenant ADMIN rows used to commit on its own before the delete the
 *     trigger refused, stranding B as an owner with no tenant access.
 *   - ATOMICITY: a removal that fails after the fan-in leaves the member's
 *     tenant rows exactly as they were.
 */
type DeprovisionHook = (orgId: string) => Promise<void>;
let beforeDeprovision: DeprovisionHook | null = null;
let failAfterDeprovision = false;
jest.mock('@/app-layer/usecases/org-provisioning', () => {
    const actual = jest.requireActual('@/app-layer/usecases/org-provisioning');
    return {
        __esModule: true,
        ...actual,
        deprovisionOrgAdmin: async (orgId: string, ...rest: unknown[]) => {
            if (beforeDeprovision) await beforeDeprovision(orgId);
            const result = await actual.deprovisionOrgAdmin(orgId, ...rest);
            if (failAfterDeprovision) throw new Error('injected failure after the fan-in');
            return result;
        },
    };
});

import { PrismaClient, type OrgRole } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import {
    deleteAuditRowsForTenants,
    deleteAuditRowsForUsers,
    deleteOrgAuditRowsForOrganizations,
} from '../helpers/audit-cleanup';
import { getOrgPermissions } from '@/lib/permissions';
import { changeOrgMemberRole, removeOrgMember } from '@/app-layer/usecases/org-members';
import { createTenantUnderOrg } from '@/app-layer/usecases/org-tenants';
import type { OrgContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const userIds: string[] = [];
const orgIds: string[] = [];
const tenantIds: string[] = [];
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))`;
const TX = { timeout: 30_000, maxWait: 30_000 };

let seq = 0;
async function user(label: string): Promise<string> {
    const u = await prisma.user.create({
        data: { email: `${label}-${seq++}-${SUITE}@example.com`, name: label },
    });
    userIds.push(u.id);
    return u.id;
}
async function org(label: string): Promise<string> {
    const o = await prisma.organization.create({ data: { name: label, slug: `${label}-${seq++}-${SUITE}` } });
    orgIds.push(o.id);
    return o.id;
}
async function member(organizationId: string, userId: string, role: OrgRole) {
    await prisma.orgMembership.create({ data: { organizationId, userId, role } });
}
const owners = (organizationId: string) =>
    prisma.orgMembership.count({ where: { organizationId, role: 'ORG_OWNER' } });
const roleIn = async (organizationId: string, userId: string) =>
    (
        await prisma.orgMembership.findUnique({
            where: { organizationId_userId: { organizationId, userId } },
            select: { role: true },
        })
    )?.role ?? null;
const tenantRole = async (tenantId: string, userId: string) =>
    (await prisma.tenantMembership.findFirst({ where: { tenantId, userId }, select: { role: true } }))?.role ?? null;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves `true` once `p` settles, or `false` after `ms`. */
const settlesWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

async function twoOwners(label: string) {
    const o = await org(label);
    const a = await user(`${label}-a`);
    const b = await user(`${label}-b`);
    await member(o, a, 'ORG_OWNER');
    await member(o, b, 'ORG_OWNER');
    return { o, a, b };
}

afterEach(() => {
    beforeDeprovision = null;
    failAfterDeprovision = false;
});

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
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await deleteAuditRowsForUsers(prisma, userIds);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

describe('the trigger serialises owner changes per organization', () => {
    it('refuses the second of two concurrent cross-demotions, whatever the writer', async () => {
        const { o, a, b } = await twoOwners('trg');

        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let demotedB!: () => void;
        const bDemoted = new Promise<void>((r) => (demotedB = r));

        // Transaction 1 demotes B (A is still an owner, so its count passes)
        // and stays open.
        const t1 = prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE "OrgMembership" SET "role" = 'ORG_ADMIN' WHERE "organizationId" = $1 AND "userId" = $2`,
                o,
                b,
            );
            demotedB();
            await held;
        }, TX);
        await bDemoted;

        // Transaction 2 demotes A while 1 is uncommitted.
        const t2 = prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
                `UPDATE "OrgMembership" SET "role" = 'ORG_ADMIN' WHERE "organizationId" = $1 AND "userId" = $2`,
                o,
                a,
            );
        }, TX);
        const t2Result = t2.then(
            () => 'committed' as const,
            (e: unknown) => e,
        );

        // It must WAIT for transaction 1 — it touches a different row, so
        // nothing but the per-organization lock can hold it.
        expect(await settlesWithin(t2Result, 500)).toBe(false);

        release();
        await t1;
        const outcome = await t2Result;
        expect(outcome).not.toBe('committed');
        expect(String((outcome as Error).message)).toMatch(/LAST_ORG_OWNER_GUARD/);

        expect(await owners(o)).toBe(1);
        expect(await roleIn(o, a)).toBe('ORG_OWNER');
        expect(await roleIn(o, b)).toBe('ORG_ADMIN');
    });
});

describe('the role change', () => {
    it('A demotes B while B demotes A: exactly one wins, one owner remains', async () => {
        for (let i = 0; i < 6; i++) {
            const { o, a, b } = await twoOwners(`rc${i}`);

            // Hold the organization's lock so BOTH calls pass their
            // pre-transaction count (each sees two owners) before either
            // writes. Released, they race for it.
            let release!: () => void;
            const held = new Promise<void>((r) => (release = r));
            let locked!: () => void;
            const isLocked = new Promise<void>((r) => (locked = r));
            const barrier = prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(LOCK_SQL, `org-owner:${o}`);
                locked();
                await held;
            }, TX);
            await isLocked;

            const results = Promise.allSettled([
                changeOrgMemberRole(ctx(o, a, 'ORG_OWNER'), { userId: b, role: 'ORG_ADMIN' }),
                changeOrgMemberRole(ctx(o, b, 'ORG_OWNER'), { userId: a, role: 'ORG_ADMIN' }),
            ]);
            await sleep(150);
            release();
            await barrier;
            const [ra, rb] = await results;

            const won = [ra, rb].filter((r) => r.status === 'fulfilled');
            const lost = [ra, rb].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            expect(won).toHaveLength(1);
            expect(lost).toHaveLength(1);
            expect(lost[0].reason).toMatchObject({ status: 409, details: { reason: 'LAST_ORG_OWNER' } });
            expect(await owners(o)).toBe(1);
        }
    });
});

describe('the removal', () => {
    async function ownedOrgWithTenant(label: string) {
        const { o, a, b } = await twoOwners(label);
        const c = await user(`${label}-c`);
        await member(o, c, 'ORG_ADMIN');
        const t = await createTenantUnderOrg(ctx(o, a, 'ORG_OWNER'), {
            name: `${label}-${SUITE}`,
            slug: `${label}-t-${seq++}-${SUITE}`,
        });
        tenantIds.push(t.tenant.id);
        expect(await tenantRole(t.tenant.id, b)).toBe('ADMIN');
        expect(await tenantRole(t.tenant.id, c)).toBe('ADMIN');
        return { o, a, b, c, tenantId: t.tenant.id };
    }

    it('A removes B while A is demoted: one owner remains and no administrator loses tenant access', async () => {
        const { o, a, b, tenantId } = await ownedOrgWithTenant('rm');

        // The concurrent demotion of A, started the moment the removal
        // begins its fan-in. Without serialisation it commits at once (B is
        // still an owner), and the removal's delete is then refused by the
        // trigger after B's tenant rows have already gone.
        let demotion: Promise<unknown> | null = null;
        beforeDeprovision = async () => {
            demotion = prisma.orgMembership
                .update({ where: { organizationId_userId: { organizationId: o, userId: a } }, data: { role: 'ORG_ADMIN' } })
                .catch((e: unknown) => e);
            await settlesWithin(demotion, 500);
        };

        const removal = await removeOrgMember(ctx(o, a, 'ORG_OWNER'), { userId: b }).then(
            () => 'removed' as const,
            (e: unknown) => e,
        );
        await demotion;

        // The organization keeps exactly one owner…
        expect(await owners(o)).toBe(1);
        // …and every administrator who is still one keeps their tenant access.
        for (const u of [a, b]) {
            const role = await roleIn(o, u);
            if (role === 'ORG_OWNER' || role === 'ORG_ADMIN') {
                expect(await tenantRole(tenantId, u)).not.toBeNull();
            }
        }
        // With serialisation the removal goes through and the demotion is the
        // one refused.
        expect(removal).toBe('removed');
        expect(await roleIn(o, a)).toBe('ORG_OWNER');
    });

    it('a removal that fails after the fan-in leaves the tenant memberships intact', async () => {
        const { o, a, c, tenantId } = await ownedOrgWithTenant('atom');
        failAfterDeprovision = true;

        await expect(removeOrgMember(ctx(o, a, 'ORG_OWNER'), { userId: c })).rejects.toThrow(/injected failure/);

        expect(await roleIn(o, c)).toBe('ORG_ADMIN');
        expect(await tenantRole(tenantId, c)).toBe('ADMIN');
    });

    it('a refused removal of the last owner touches no tenant membership', async () => {
        const o = await org('last');
        const a = await user('last-a');
        await member(o, a, 'ORG_OWNER');
        const c = await user('last-c');
        await member(o, c, 'ORG_ADMIN');
        const t = await createTenantUnderOrg(ctx(o, a, 'ORG_OWNER'), {
            name: `last-${SUITE}`,
            slug: `last-t-${seq++}-${SUITE}`,
        });
        tenantIds.push(t.tenant.id);
        const before = await prisma.tenantMembership.count({ where: { tenantId: t.tenant.id } });

        await expect(removeOrgMember(ctx(o, a, 'ORG_OWNER'), { userId: a })).rejects.toMatchObject({
            status: 409,
            details: { reason: 'LAST_ORG_OWNER' },
        });

        expect(await roleIn(o, a)).toBe('ORG_OWNER');
        expect(await prisma.tenantMembership.count({ where: { tenantId: t.tenant.id } })).toBe(before);
    });
});
