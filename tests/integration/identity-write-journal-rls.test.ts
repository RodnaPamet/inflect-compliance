/**
 * `IdentityWriteJournal` — RLS behaviour, and the outlives-the-link contract.
 *
 * The structural guardrail certifies the policies EXIST. This is conduct: it
 * drives the table under two tenant contexts and asserts what a tenant-B caller
 * can actually do.
 *
 * The stakes are specific. This table holds the captured prior state that makes
 * an offboarding reversible, and the evidence that an automated system changed a
 * named person's access. A cross-tenant read is one tenant seeing which of
 * another tenant's people were disabled and when.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'iwj-tenant-one';
const T2 = 'iwj-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.identityWriteJournal.deleteMany({ where: t });
    await prisma.identityAccountLink.deleteMany({ where: t });
    await prisma.connectedIdentityAccount.deleteMany({ where: t });
    // The FK is ON DELETE CASCADE now, so deleting the connection would take its
    // accounts with it — but the accounts go first anyway, because this cleanup
    // must not depend on cascade ordering to leave the table empty.
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { linkId: string; journalId: string; accountId: string }> = {};

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
    }

    for (const t of [T1, T2]) {
        const employee = await prisma.employee.create({
            data: { tenantId: t, fullName: `Worker ${t}`, workEmail: `worker@${t}.test` },
        });
        // An account belongs to the connection whose sync observed it —
        // `connectionId` is required, so a fixture cannot skip it any more. That
        // is the schema saying what was always true: a row exists because a
        // connection went and looked.
        const connection = await prisma.integrationConnection.create({
            data: { tenantId: t, provider: 'entra-id', name: `entra-${t}`, configJson: {} },
        });
        const account = await prisma.connectedIdentityAccount.create({
            data: {
                tenantId: t,
                provider: 'entra-id',
                connectionId: connection.id,
                externalUserId: `ext-${t}`,
                email: `worker@${t}.test`,
                syncedAt: new Date(),
            },
        });
        const link = await prisma.identityAccountLink.create({
            data: { tenantId: t, employeeId: employee.id, connectedAccountId: account.id, matchMethod: 'EMAIL_EXACT', lastVerifiedAt: new Date() },
        });
        const journal = await prisma.identityWriteJournal.create({
            data: {
                tenantId: t, linkId: link.id, provider: 'entra-id', externalUserId: `ext-${t}`,
                action: 'DISABLE_ACCOUNT', mode: 'AUTOMATIC',
                priorStateJson: { accountEnabled: true }, outcome: 'APPLIED',
            },
        });
        seeded[t] = { linkId: link.id, journalId: journal.id, accountId: account.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a tenant sees only its own journal', () => {
    it('BOTH rows really exist — otherwise every assertion below is vacuous', async () => {
        // `toHaveLength(1)` passes just as happily when the other tenant's row
        // was never created. Read as superuser so the rows RLS hides are proven
        // to be there.
        const all = await prisma.identityWriteJournal.findMany({});
        expect(all).toHaveLength(2);
        expect(all.map((r) => r.tenantId).sort()).toEqual([T1, T2]);
    });

    it('each tenant reads exactly its own', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.identityWriteJournal.findMany({}));
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(seeded[t].journalId);
        }
    });

    it("naming the OTHER tenant's row by id returns nothing", async () => {
        const row = await asTenant(T1, (tx) =>
            tx.identityWriteJournal.findFirst({ where: { id: seeded[T2].journalId } }),
        );
        expect(row).toBeNull();
    });

    it('the captured prior state does not leak across the boundary', async () => {
        // This is the payload that says what a named person's access WAS.
        const rows = await asTenant(T1, (tx) => tx.identityWriteJournal.findMany({}));
        expect(rows.map((r) => r.externalUserId)).toEqual([`ext-${T1}`]);
    });
});

describe("a tenant cannot write another tenant's journal", () => {
    it('INSERT with a foreign tenantId is refused', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.identityWriteJournal.create({
                    data: {
                        tenantId: T2, provider: 'entra-id', externalUserId: 'smuggled',
                        action: 'DISABLE_ACCOUNT', mode: 'AUTOMATIC', priorStateJson: { accountEnabled: true },
                    },
                }),
            ),
        ).rejects.toThrow();
    });

    it("UPDATE of the other tenant's row changes nothing", async () => {
        const res = await asTenant(T1, (tx) =>
            tx.identityWriteJournal.updateMany({ where: { id: seeded[T2].journalId }, data: { outcome: 'REVERTED' } }),
        );
        expect(res.count).toBe(0);
        const after = await prisma.identityWriteJournal.findUnique({ where: { id: seeded[T2].journalId } });
        expect(after?.outcome).toBe('APPLIED');
    });

    it('cannot reassign its OWN row to another tenant', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.identityWriteJournal.update({ where: { id: seeded[T1].journalId }, data: { tenantId: T2 } }),
            ),
        ).rejects.toThrow();
    });
});

describe('the journal outlives what it describes', () => {
    it('deleting the link leaves the journal row, with linkId nulled', async () => {
        // SET NULL, not CASCADE. Deleting an employee for privacy must not
        // erase the record that their access was revoked — that record is
        // frequently the artefact an auditor asks for.
        const before = await prisma.identityWriteJournal.findUnique({ where: { id: seeded[T2].journalId } });
        expect(before?.linkId).toBe(seeded[T2].linkId);

        await prisma.identityAccountLink.delete({ where: { id: seeded[T2].linkId } });

        const after = await prisma.identityWriteJournal.findUnique({ where: { id: seeded[T2].journalId } });
        expect(after).not.toBeNull();
        expect(after?.linkId).toBeNull();
        // And the denormalised target survives, so a restore can still find it.
        expect(after?.externalUserId).toBe(`ext-${T2}`);
        expect(after?.priorStateJson).toEqual({ accountEnabled: true });
    });
});
