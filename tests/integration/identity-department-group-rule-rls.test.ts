/**
 * `IdentityDepartmentGroupRule` — RLS behaviour, under two tenant contexts.
 *
 * The structural guardrail (`rls-coverage`) certifies the policies EXIST. This
 * is CONDUCT: it drives the table as `app_user` under two tenants and asserts
 * what a tenant-B caller can actually do.
 *
 * The stakes are specific to this table. It decides WHICH SECURITY GROUP a new
 * joiner is added to. A cross-tenant read tells one customer how another
 * structures its directory entitlements; a cross-tenant WRITE would let one
 * customer choose the group a different customer's new employee lands in. That
 * is a privilege-escalation path into somebody else's directory, which is why
 * this model goes straight into ISOLATION_TESTED rather than taking the
 * BASELINE escape hatch meant for models that pre-date the lock.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'idgr-tenant-one';
const T2 = 'idgr-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list that does not include this one,
 * so this suite clears its own rows — otherwise it passes exactly once on a
 * fresh database and fails every re-run, and CI always starts clean, which is
 * precisely what would hide it.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.identityDepartmentGroupRule.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
    }
    for (const t of [T1, T2]) {
        await prisma.identityDepartmentGroupRule.create({
            data: {
                tenantId: t,
                department: 'Engineering',
                groupId: `grp-eng-${t}`,
                groupName: 'Engineering',
            },
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('IdentityDepartmentGroupRule — tenant isolation', () => {
    it('a tenant reads only its OWN rules', async () => {
        const rows = await asTenant(T1, (tx) =>
            tx.identityDepartmentGroupRule.findMany({ orderBy: { groupId: 'asc' } }),
        );
        // Positive control first: if the seed were missing, "sees nothing from
        // T2" would pass vacuously and prove the opposite of what it claims.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tenantId).toBe(T1);
        expect(rows[0]?.groupId).toBe(`grp-eng-${T1}`);
    });

    it("cannot read another tenant's rule even by its own id", async () => {
        const mine = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findFirst({ where: { tenantId: T2 } }),
        );
        expect(mine).not.toBeNull();

        const theirs = await asTenant(T1, (tx) =>
            tx.identityDepartmentGroupRule.findUnique({ where: { id: mine!.id } }),
        );
        expect(theirs).toBeNull();
    });

    it("cannot UPDATE another tenant's rule — the group a joiner lands in", async () => {
        const target = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findFirst({ where: { tenantId: T2 } }),
        );

        const changed = await asTenant(T1, (tx) =>
            tx.identityDepartmentGroupRule.updateMany({
                where: { id: target!.id },
                data: { groupId: 'grp-attacker-controlled' },
            }),
        );
        expect(changed.count).toBe(0);

        // And the row is genuinely untouched, not merely reported as unchanged.
        const after = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findUnique({ where: { id: target!.id } }),
        );
        expect(after?.groupId).toBe(`grp-eng-${T2}`);
    });

    it("cannot INSERT a rule into another tenant", async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.identityDepartmentGroupRule.create({
                    data: {
                        tenantId: T2,
                        department: 'Finance',
                        groupId: 'grp-smuggled',
                    },
                }),
            ),
        ).rejects.toThrow();

        const rows = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findMany({ where: { department: 'Finance' } }),
        );
        expect(rows).toHaveLength(0);
    });

    it("cannot DELETE another tenant's rule", async () => {
        const target = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findFirst({ where: { tenantId: T2 } }),
        );
        const deleted = await asTenant(T1, (tx) =>
            tx.identityDepartmentGroupRule.deleteMany({ where: { id: target!.id } }),
        );
        expect(deleted.count).toBe(0);

        const still = await asTenant(T2, (tx) =>
            tx.identityDepartmentGroupRule.findUnique({ where: { id: target!.id } }),
        );
        expect(still).not.toBeNull();
    });
});
