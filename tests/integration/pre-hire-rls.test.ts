/**
 * `PreHire` — RLS behaviour under two tenant contexts.
 *
 * The structural guardrail certifies the policies EXIST; this is CONDUCT.
 *
 * The stakes: this table holds a named person, their department and their
 * start date, for people who do not yet have an account anywhere. A
 * cross-tenant read is one customer seeing who is about to join another —
 * hiring intelligence, before the person has even started.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
// Static, not `await import(...)`: `usecase-test-coverage` only counts
// `from '<specifier>'` imports, so a dynamic one leaves the usecase reading as
// untested. The guard is right to be narrow — a dynamic import inside one
// `it()` is not the same coverage claim as the module being loaded by the
// suite.
import {
    recordPreHire,
    reconcilePreHire,
    listPendingPreHires,
} from '@/app-layer/usecases/pre-hire';

const prisma: PrismaClient = prismaTestClient();
const T1 = 'ph-tenant-one';
const T2 = 'ph-tenant-two';

async function asTenant<T>(t: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${t}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** `resetDatabase` truncates a fixed list that excludes this table. */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.preHire.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'One'], [T2, 'Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        await prisma.preHire.create({
            data: { tenantId: id, externalId: `wd-${id}`, fullName: `Starter ${id}` },
        });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('PreHire — tenant isolation', () => {
    it('a tenant sees only its own pre-hires', async () => {
        const rows = await asTenant(T1, (tx) => tx.preHire.findMany());
        // Positive control: without this, "sees nothing from T2" passes on an
        // empty table and asserts the opposite of what it claims.
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tenantId).toBe(T1);
    });

    it("cannot read another tenant's pre-hire by id", async () => {
        const mine = await asTenant(T2, (tx) => tx.preHire.findFirst());
        expect(mine).not.toBeNull();
        const theirs = await asTenant(T1, (tx) => tx.preHire.findUnique({ where: { id: mine!.id } }));
        expect(theirs).toBeNull();
    });

    it("cannot INSERT into another tenant", async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.preHire.create({ data: { tenantId: T2, externalId: 'smuggled', fullName: 'X' } }),
            ),
        ).rejects.toThrow();
        const rows = await asTenant(T2, (tx) => tx.preHire.findMany({ where: { externalId: 'smuggled' } }));
        expect(rows).toHaveLength(0);
    });

    it("cannot UPDATE or DELETE another tenant's pre-hire", async () => {
        const target = await asTenant(T2, (tx) => tx.preHire.findFirst());
        const upd = await asTenant(T1, (tx) =>
            tx.preHire.updateMany({ where: { id: target!.id }, data: { fullName: 'tampered' } }),
        );
        expect(upd.count).toBe(0);
        const del = await asTenant(T1, (tx) => tx.preHire.deleteMany({ where: { id: target!.id } }));
        expect(del.count).toBe(0);
        const after = await asTenant(T2, (tx) => tx.preHire.findUnique({ where: { id: target!.id } }));
        expect(after?.fullName).toBe(`Starter ${T2}`);
    });
});

describe('reconciliation does not mint a duplicate employee (#2715 acceptance)', () => {
    // The failure this whole model exists to prevent, asserted against the
    // `tenantId_workEmail` key specifically — which is the key the HRIS upsert
    // addresses rows by and the one a direct `Employee.workEmail` write would
    // make it miss.
    it('an Employee arriving later is MATCHED on externalId, not created', async () => {
        const EXT = `wd-${T1}`;
        const employee = await prisma.employee.create({
            data: {
                tenantId: T1,
                externalId: EXT,
                fullName: 'Starter One',
                workEmail: 'starter.one@t1.test',
            },
        });

        const before = await prisma.employee.count({ where: { tenantId: T1 } });

        const pre = await prisma.preHire.findFirst({ where: { tenantId: T1, externalId: EXT } });
        const out = await reconcilePreHire(
            { tenantId: T1, userId: 'u-1' } as never,
            pre!.id,
        );

        expect(out.kind).toBe('RECONCILED');
        if (out.kind === 'RECONCILED') expect(out.employeeId).toBe(employee.id);

        // THE ASSERTION THAT MATTERS: no second row for the same person.
        expect(await prisma.employee.count({ where: { tenantId: T1 } })).toBe(before);

        // And the unique key is intact and still addresses exactly one row.
        const byKey = await prisma.employee.findUnique({
            where: { tenantId_workEmail: { tenantId: T1, workEmail: 'starter.one@t1.test' } },
        });
        expect(byKey?.id).toBe(employee.id);
    });

    it('reconciling twice is idempotent, not a second link', async () => {
        const pre = await prisma.preHire.findFirst({ where: { tenantId: T1, externalId: `wd-${T1}` } });
        const again = await reconcilePreHire({ tenantId: T1, userId: 'u-1' } as never, pre!.id);
        expect(again.kind).toBe('ALREADY');
    });

    it('a pre-hire with no Employee yet reports NOT_YET rather than inventing one', async () => {
        const ctx = { tenantId: T1, userId: 'u-1' } as never;
        const fresh = await recordPreHire(ctx, { externalId: 'wd-nobody', fullName: 'Not Yet' });
        const before = await prisma.employee.count({ where: { tenantId: T1 } });
        const out = await reconcilePreHire(ctx, fresh.id);
        expect(out.kind).toBe('NOT_YET');
        expect(await prisma.employee.count({ where: { tenantId: T1 } })).toBe(before);
    });
});


describe('recording and listing', () => {
    const ctx = { tenantId: T2, userId: 'u-2' } as never;

    it('recordPreHire is idempotent on (tenantId, externalId)', async () => {
        const before = await prisma.preHire.count({ where: { tenantId: T2 } });
        const a = await recordPreHire(ctx, { externalId: 'wd-dup', fullName: 'Dup One' });
        const b = await recordPreHire(ctx, { externalId: 'wd-dup', fullName: 'Dup One Renamed' });
        expect(b.id).toBe(a.id);
        expect(await prisma.preHire.count({ where: { tenantId: T2 } })).toBe(before + 1);
        // The refresh updates the mutable fields...
        expect(b.fullName).toBe('Dup One Renamed');
    });

    it('a refresh does NOT resurrect a reconciled row into PENDING', async () => {
        // The roster re-reporting someone does not un-hire them. Without this
        // the upsert's `update` arm would quietly undo a reconciliation.
        const row = await recordPreHire(ctx, { externalId: 'wd-done', fullName: 'Done' });
        await prisma.preHire.update({
            where: { id: row.id },
            data: { status: 'RECONCILED', reconciledEmployeeId: 'emp-x', reconciledAt: new Date() },
        });
        const again = await recordPreHire(ctx, { externalId: 'wd-done', fullName: 'Done Again' });
        expect(again.status).toBe('RECONCILED');
        expect(again.reconciledEmployeeId).toBe('emp-x');
    });

    it('listPendingPreHires returns only PENDING rows, for this tenant only', async () => {
        const pending = await listPendingPreHires(ctx);
        expect(pending.length).toBeGreaterThan(0);
        expect(pending.every((p) => p.status === 'PENDING')).toBe(true);
        // The reconciled row from the test above must not appear.
        expect(pending.some((p) => p.externalId === 'wd-done')).toBe(false);
    });

    it('reconcilePreHire refuses an id from another tenant', async () => {
        const otherTenantRow = await prisma.preHire.findFirst({ where: { tenantId: T1 } });
        await expect(
            reconcilePreHire(ctx, otherTenantRow!.id),
        ).rejects.toThrow(/No pre-hire/);
    });
});
