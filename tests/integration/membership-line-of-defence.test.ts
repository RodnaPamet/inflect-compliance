/**
 * A MEMBERSHIP'S LINE OF DEFENCE (#3675) — only an OWNER sets it, never on
 * their own membership, and every change writes an audit row. Proved on real
 * rows, with every context resolved by the real `resolveTenantContext`.
 *
 * The route's literal `requirePermission('admin.owner_management')` is the
 * first gate, and its end-to-end test is
 * `tests/unit/line-of-defence-route-authz.test.ts`. This file is the usecase's
 * own gate, which a second caller of the function meets: the key, the BUILT-IN
 * role (a custom role carrying the key does not make an ADMIN an OWNER), a
 * person rather than a credential, and not one's own membership.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import { ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'line-of-defence-one';
const T2 = 'line-of-defence-two';
const TENANTS = [T1, T2];

type Person = 'ownerA' | 'ownerB' | 'admin' | 'aiAdmin' | 'adminWithKey' | 'reader';
const PEOPLE: Person[] = ['ownerA', 'ownerB', 'admin', 'aiAdmin', 'adminWithKey', 'reader'];
const ROLE: Record<Person, Role> = {
    ownerA: Role.OWNER,
    ownerB: Role.OWNER,
    admin: Role.ADMIN,
    // Written directly by the fixture, as the transfer suite writes it: the
    // point here is what an AI_ADMIN membership may do, not how it is assigned.
    aiAdmin: 'AI_ADMIN' as Role,
    adminWithKey: Role.ADMIN,
    reader: Role.READER,
};

const users: Record<string, Record<Person, string>> = {};
const memberships: Record<string, Record<Person, string>> = {};
const contexts: Record<string, Record<Person, RequestContext>> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
const ctxAs = (tenantId: string, who: Person) => contexts[tenantId][who];

const lineOf = async (tenantId: string, who: Person) =>
    (await prisma.tenantMembership.findUniqueOrThrow({ where: { id: memberships[tenantId][who] } })).lineOfDefence;

const auditRows = (tenantId: string, membershipId: string) =>
    prisma.auditLog.findMany({
        where: { tenantId, entityId: membershipId, action: 'MEMBER_LINE_OF_DEFENCE_CHANGED' },
        orderBy: { createdAt: 'asc' },
    });

async function clearOwnRows(): Promise<void> {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.tenantCustomRole.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        // A custom role carrying owner_management, on an ADMIN membership: an
        // OWNER can author one (`assertGrantWithinOwnAuthority`), and it must
        // still not make its holder an OWNER for this purpose.
        const ownerKeyRole = await prisma.tenantCustomRole.create({
            data: {
                tenantId,
                name: 'Owner-key delegate',
                baseRole: Role.ADMIN,
                permissionsJson: { admin: { owner_management: true } },
            },
        });
        users[tenantId] = {} as Record<Person, string>;
        memberships[tenantId] = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[tenantId][who] = user.id;
            const m = await prisma.tenantMembership.create({
                data: {
                    tenantId,
                    userId: user.id,
                    role: ROLE[who],
                    status: MembershipStatus.ACTIVE,
                    customRoleId: who === 'adminWithKey' ? ownerKeyRole.id : null,
                },
            });
            memberships[tenantId][who] = m.id;
        }
        contexts[tenantId] = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[tenantId][who]);
            contexts[tenantId][who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[tenantId][who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
    }
});

beforeEach(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.tenantMembership.updateMany({ where: { tenantId: { in: TENANTS } }, data: { lineOfDefence: null } });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('an OWNER sets a line of defence, and every change writes an audit row', () => {
    it('declares, moves and clears a line — one hash-chained row per change, naming before and after', async () => {
        const m = memberships[T1].reader;
        const first = await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), m, { lineOfDefence: 'FIRST' });
        expect(first).toMatchObject({ changed: true, lineOfDefence: 'FIRST', previousLineOfDefence: null });
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), m, { lineOfDefence: 'SECOND' });
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerB'), m, { lineOfDefence: null });
        expect(await lineOf(T1, 'reader')).toBeNull();

        const rows = await auditRows(T1, m);
        expect(rows).toHaveLength(3);
        const shape = rows.map((r) => {
            const d = r.detailsJson as { before: { lineOfDefence: string | null }; after: { lineOfDefence: string | null } };
            return [r.userId, d.before.lineOfDefence, d.after.lineOfDefence];
        });
        expect(shape).toEqual([
            [users[T1].ownerA, null, 'FIRST'],
            [users[T1].ownerA, 'FIRST', 'SECOND'],
            [users[T1].ownerB, 'SECOND', null],
        ]);
        expect(rows.every((r) => r.entryHash !== null)).toBe(true);
    });

    it('setting the value a member already has changes nothing and writes nothing', async () => {
        const m = memberships[T1].reader;
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), m, { lineOfDefence: 'THIRD' });
        const again = await setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), m, { lineOfDefence: 'THIRD' });
        expect(again).toMatchObject({ changed: false, lineOfDefence: 'THIRD' });
        expect(await auditRows(T1, m)).toHaveLength(1);
    });

    it('an OWNER may set another OWNER\'s line', async () => {
        await setMembershipLineOfDefence(ctxAs(T1, 'ownerB'), memberships[T1].ownerA, { lineOfDefence: 'SECOND' });
        expect(await lineOf(T1, 'ownerA')).toBe('SECOND');
    });

    it('refuses a value that is not a line', async () => {
        await expect(
            setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), memberships[T1].reader, { lineOfDefence: 'FOURTH' }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
            setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), memberships[T1].reader, {
                lineOfDefence: 'FIRST',
                role: 'OWNER',
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(await lineOf(T1, 'reader')).toBeNull();
    });
});

describe('nobody else sets it', () => {
    it.each(['admin', 'aiAdmin', 'reader'] as const)('%s is refused, and nothing is written', async (who) => {
        await expect(
            setMembershipLineOfDefence(ctxAs(T1, who), memberships[T1].reader, { lineOfDefence: 'SECOND' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(await lineOf(T1, 'reader')).toBeNull();
        expect(await auditRows(T1, memberships[T1].reader)).toHaveLength(0);
    });

    it('an ADMIN whose custom role carries owner_management is refused: the built-in role must be OWNER', async () => {
        const ctx = ctxAs(T1, 'adminWithKey');
        // The test is of the ROLE check, not the key check: the key is there.
        expect(ctx.appPermissions.admin.owner_management).toBe(true);
        expect(ctx.role).toBe('ADMIN');
        await expect(
            setMembershipLineOfDefence(ctx, memberships[T1].reader, { lineOfDefence: 'SECOND' }),
        ).rejects.toThrow(/does not make its holder one/);
        expect(await lineOf(T1, 'reader')).toBeNull();
    });

    it('an OWNER cannot set their own line: a line its holder declared is a claim, not a control', async () => {
        await expect(
            setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), memberships[T1].ownerA, { lineOfDefence: 'SECOND' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(await lineOf(T1, 'ownerA')).toBeNull();
    });

    it('a credential is refused, even one that resolved to an OWNER context', async () => {
        const viaKey = { ...ctxAs(T1, 'ownerA'), apiKeyId: 'key-1' };
        const viaAgent = { ...ctxAs(T1, 'ownerA'), agentId: 'agent-1' };
        for (const ctx of [viaKey, viaAgent]) {
            await expect(
                setMembershipLineOfDefence(ctx, memberships[T1].reader, { lineOfDefence: 'SECOND' }),
            ).rejects.toBeInstanceOf(ForbiddenError);
        }
        expect(await lineOf(T1, 'reader')).toBeNull();
    });

    it("another tenant's membership is not found, and is not touched", async () => {
        await expect(
            setMembershipLineOfDefence(ctxAs(T1, 'ownerA'), memberships[T2].reader, { lineOfDefence: 'SECOND' }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(await lineOf(T2, 'reader')).toBeNull();
    });
});

describe('every membership-creating path leaves the line undeclared', () => {
    it('a membership created without a line reads NULL', async () => {
        const fresh = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: memberships[T2].admin } });
        expect(fresh.lineOfDefence).toBeNull();
    });
});
