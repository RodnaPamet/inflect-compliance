/**
 * Two-tenant behavioural isolation for `LegacyAccessSnapshot` and `LegacyAccount`.
 *
 * Registered in `tests/guardrails/tenant-isolation-forward-lock.test.ts`, which is
 * what obliges every new tenant table to have a test like this one rather than
 * only an RLS migration a reviewer read.
 *
 * Two layers are under test and they are not the same claim:
 *
 *  - **RLS**, exercised as `app_user` with `app.tenant_id` bound, which is how the
 *    application actually reads. A DELETE under RLS removes zero rows SILENTLY
 *    when SELECT hides them, so every destructive assertion here checks the row
 *    COUNT rather than that the call returned.
 *  - **The composite foreign keys** (`[connectionId, tenantId]`,
 *    `[snapshotId, tenantId]`), which make a cross-tenant pointer unrepresentable
 *    at the database level rather than merely refused by application code.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'lgx-tenant-one';
const T2 = 'lgx-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.legacyAccount.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { connectionId: string; snapshotId: string; accountId: string }> = {};

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
    }

    for (const t of [T1, T2]) {
        const connection = await prisma.integrationConnection.create({
            data: { tenantId: t, provider: 'legacy-mcp', name: `legacy-${t}`, configJson: {} },
        });
        const snapshot = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: t,
                connectionId: connection.id,
                remoteSnapshotId: `snap-${t}`,
                mappingVersion: 1,
                columnSetFingerprint: 'f'.repeat(64),
                payloadHash: 'h'.repeat(64),
                rowCount: 1,
                rowsReceived: 1,
                status: 'COMPLETE',
                completedAt: new Date(),
            },
        });
        const account = await prisma.legacyAccount.create({
            data: {
                tenantId: t,
                snapshotId: snapshot.id,
                accountKey: `acct-${t}`,
                email: `worker@${t}.test`,
                status: 'ACTIVE',
                accountType: 'HUMAN',
                entitlements: ['reader'],
            },
        });
        seeded[t] = { connectionId: connection.id, snapshotId: snapshot.id, accountId: account.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('LegacyAccessSnapshot — tenant isolation', () => {
    it('each tenant sees only its own snapshot', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.legacyAccessSnapshot.findMany({}));
            expect(rows.map((r) => r.tenantId)).toEqual([t]);
        }
    });

    it('a tenant cannot read the other tenant snapshot by id', async () => {
        const row = await asTenant(T2, (tx) =>
            tx.legacyAccessSnapshot.findUnique({ where: { id: seeded[T1].snapshotId } })
        );
        expect(row).toBeNull();
    });

    it('an unbound context reads NOTHING — the fail-closed default', async () => {
        // No `app.tenant_id` set: the policy compares against an empty string, so
        // a missing context is not an escape hatch.
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            return tx.legacyAccessSnapshot.findMany({});
        });
        expect(rows).toEqual([]);
    });

    it('refuses an INSERT claiming the other tenant', async () => {
        await expect(
            asTenant(T2, (tx) =>
                tx.legacyAccessSnapshot.create({
                    data: {
                        tenantId: T1,
                        connectionId: seeded[T1].connectionId,
                        remoteSnapshotId: 'forged',
                        mappingVersion: 1,
                        columnSetFingerprint: 'f'.repeat(64),
                    },
                })
            )
        ).rejects.toThrow();
    });

    it('an UPDATE of the other tenant row changes ZERO rows, and the row is untouched', async () => {
        const res = await asTenant(T2, (tx) =>
            tx.legacyAccessSnapshot.updateMany({
                where: { id: seeded[T1].snapshotId },
                data: { status: 'PARTIAL' },
            })
        );
        expect(res.count).toBe(0);
        // Verified from OUTSIDE the tenant context: an RLS-hidden row that was in
        // fact modified would look identical from inside.
        const after = await prisma.legacyAccessSnapshot.findUniqueOrThrow({
            where: { id: seeded[T1].snapshotId },
        });
        expect(after.status).toBe('COMPLETE');
    });

    it('a DELETE of the other tenant row removes ZERO rows, and the row survives', async () => {
        // The count is the assertion. A DELETE under RLS succeeds while removing
        // nothing when SELECT hides the target, so "it did not throw" says nothing.
        const res = await asTenant(T2, (tx) =>
            tx.legacyAccessSnapshot.deleteMany({ where: { id: seeded[T1].snapshotId } })
        );
        expect(res.count).toBe(0);
        await expect(
            prisma.legacyAccessSnapshot.findUniqueOrThrow({ where: { id: seeded[T1].snapshotId } })
        ).resolves.toBeTruthy();
    });

    it('cannot point a snapshot at the other tenant CONNECTION — the composite FK forbids it', async () => {
        // Not an application check: `[connectionId, tenantId]` references
        // `IntegrationConnection(id, tenantId)`, so the pair simply does not exist.
        await expect(
            prisma.legacyAccessSnapshot.create({
                data: {
                    tenantId: T2,
                    connectionId: seeded[T1].connectionId,
                    remoteSnapshotId: 'cross',
                    mappingVersion: 1,
                    columnSetFingerprint: 'f'.repeat(64),
                },
            })
        ).rejects.toThrow();
    });
});

describe('LegacyAccount — tenant isolation', () => {
    it('each tenant sees only its own accounts', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.legacyAccount.findMany({}));
            expect(rows.map((r) => r.accountKey)).toEqual([`acct-${t}`]);
        }
    });

    it('a tenant cannot read the other tenant account, so no legacy identity leaks', async () => {
        const row = await asTenant(T2, (tx) =>
            tx.legacyAccount.findUnique({ where: { id: seeded[T1].accountId } })
        );
        expect(row).toBeNull();
    });

    it('refuses an INSERT claiming the other tenant', async () => {
        await expect(
            asTenant(T2, (tx) =>
                tx.legacyAccount.create({
                    data: {
                        tenantId: T1,
                        snapshotId: seeded[T1].snapshotId,
                        accountKey: 'forged',
                    },
                })
            )
        ).rejects.toThrow();
    });

    it('cannot attach an account to the other tenant SNAPSHOT', async () => {
        await expect(
            prisma.legacyAccount.create({
                data: { tenantId: T2, snapshotId: seeded[T1].snapshotId, accountKey: 'cross' },
            })
        ).rejects.toThrow();
    });

    it('a DELETE of the other tenant account removes ZERO rows, and it survives', async () => {
        const res = await asTenant(T2, (tx) =>
            tx.legacyAccount.deleteMany({ where: { id: seeded[T1].accountId } })
        );
        expect(res.count).toBe(0);
        await expect(
            prisma.legacyAccount.findUniqueOrThrow({ where: { id: seeded[T1].accountId } })
        ).resolves.toBeTruthy();
    });

    it('accountKey is unique per snapshot, so a duplicate cannot collapse under an upsert', async () => {
        await expect(
            prisma.legacyAccount.create({
                data: {
                    tenantId: T1,
                    snapshotId: seeded[T1].snapshotId,
                    accountKey: `acct-${T1}`,
                },
            })
        ).rejects.toThrow();
    });

    it('deleting a snapshot CASCADES to its accounts, so no account outlives its evidence', async () => {
        const snap = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: T1,
                connectionId: seeded[T1].connectionId,
                remoteSnapshotId: 'cascade-probe',
                mappingVersion: 1,
                columnSetFingerprint: 'f'.repeat(64),
            },
        });
        await prisma.legacyAccount.create({
            data: { tenantId: T1, snapshotId: snap.id, accountKey: 'cascade-me' },
        });
        await prisma.legacyAccessSnapshot.delete({ where: { id: snap.id } });
        const left = await prisma.legacyAccount.count({ where: { snapshotId: snap.id } });
        expect(left).toBe(0);
    });
});
