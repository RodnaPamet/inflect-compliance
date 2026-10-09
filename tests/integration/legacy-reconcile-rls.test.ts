/**
 * Two-tenant isolation for `LegacyAccountResolution` and `LegacyIdentityAlias`.
 *
 * Registered in `tests/guardrails/tenant-isolation-forward-lock.test.ts`, which
 * is what obliges a new tenant table to have a behavioural test rather than only
 * an RLS migration somebody read.
 *
 * The alias table matters more than most: a row there is the ONE signal that can
 * turn a legacy account into a `LINKED` with no other evidence. A cross-tenant
 * read would let one customer's confirmation decide another customer's link.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();

const T1 = 'lgrx-tenant-one';
const T2 = 'lgrx-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyIdentityAlias.deleteMany({ where: t });
    await prisma.legacyAccount.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.employee.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, {
    connectionId: string; snapshotId: string; executionId: string;
    employeeId: string; resolutionId: string; aliasId: string;
}> = {};

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
        const employee = await prisma.employee.create({
            data: { tenantId: t, fullName: `Worker ${t}`, workEmail: `worker@${t}.test` },
        });
        const snapshot = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: t, connectionId: connection.id, remoteSnapshotId: `snap-${t}`,
                mappingVersion: 1, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: 'h'.repeat(64), rowCount: 1, rowsReceived: 1,
                status: 'COMPLETE', completedAt: new Date(),
            },
        });
        const execution = await prisma.integrationExecution.create({
            data: {
                tenantId: t, connectionId: connection.id, provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', status: 'PASSED',
                triggeredBy: 'manual', executedAt: new Date(), completedAt: new Date(),
            },
        });
        const resolution = await prisma.legacyAccountResolution.create({
            data: {
                tenantId: t, executionId: execution.id, snapshotId: snapshot.id,
                accountKey: `acct-${t}`, outcome: 'LINKED', method: 'EMAIL_EXACT',
                employeeId: employee.id,
                signalsJson: [{ kind: 'EMAIL_EXACT', score: 1000, evidence: `worker@${t}.test` }],
                candidatesJson: [], vetoesJson: [],
            },
        });
        const alias = await prisma.legacyIdentityAlias.create({
            data: {
                tenantId: t, connectionId: connection.id, accountKey: `acct-${t}`,
                employeeId: employee.id, method: 'CONFIRMED_ALIAS',
                confirmedAt: new Date(), signalsJson: [],
            },
        });
        seeded[t] = {
            connectionId: connection.id, snapshotId: snapshot.id, executionId: execution.id,
            employeeId: employee.id, resolutionId: resolution.id, aliasId: alias.id,
        };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('LegacyAccountResolution — tenant isolation', () => {
    it('each tenant sees only its own resolutions', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.legacyAccountResolution.findMany({}));
            expect(rows.map((r) => r.accountKey)).toEqual([`acct-${t}`]);
        }
    });

    it('a tenant cannot read the other tenant resolution, so no evidence leaks', async () => {
        // The evidence carries the other tenant's employee email.
        const row = await asTenant(T2, (tx) =>
            tx.legacyAccountResolution.findUnique({ where: { id: seeded[T1].resolutionId } })
        );
        expect(row).toBeNull();
    });

    it('an unbound context reads NOTHING', async () => {
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            return tx.legacyAccountResolution.findMany({});
        });
        expect(rows).toEqual([]);
    });

    it('refuses an INSERT claiming the other tenant', async () => {
        await expect(
            asTenant(T2, (tx) =>
                tx.legacyAccountResolution.create({
                    data: {
                        tenantId: T1, executionId: seeded[T1].executionId,
                        snapshotId: seeded[T1].snapshotId, accountKey: 'forged',
                        outcome: 'LINKED', method: 'EMAIL_EXACT',
                        signalsJson: [], candidatesJson: [], vetoesJson: [],
                    },
                })
            )
        ).rejects.toThrow();
    });

    it('a DELETE of the other tenant row removes ZERO rows, and it survives', async () => {
        // The count is the assertion: a DELETE under RLS succeeds while removing
        // nothing when SELECT hides the target.
        const res = await asTenant(T2, (tx) =>
            tx.legacyAccountResolution.deleteMany({ where: { id: seeded[T1].resolutionId } })
        );
        expect(res.count).toBe(0);
        await expect(
            prisma.legacyAccountResolution.findUniqueOrThrow({ where: { id: seeded[T1].resolutionId } })
        ).resolves.toBeTruthy();
    });

    it('cannot attach a resolution to the other tenant SNAPSHOT or EXECUTION', async () => {
        // Composite FKs: the (id, tenantId) pair simply does not exist.
        await expect(
            prisma.legacyAccountResolution.create({
                data: {
                    tenantId: T2, executionId: seeded[T1].executionId,
                    snapshotId: seeded[T2].snapshotId, accountKey: 'cross-exec',
                    outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
                    signalsJson: [], candidatesJson: [], vetoesJson: [],
                },
            })
        ).rejects.toThrow();
        await expect(
            prisma.legacyAccountResolution.create({
                data: {
                    tenantId: T2, executionId: seeded[T2].executionId,
                    snapshotId: seeded[T1].snapshotId, accountKey: 'cross-snap',
                    outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
                    signalsJson: [], candidatesJson: [], vetoesJson: [],
                },
            })
        ).rejects.toThrow();
    });

    it('is keyed per RUN, so a second run ADDS rather than colliding', async () => {
        // The immutability property, at the schema level: `(executionId,
        // accountKey)` rather than `(snapshotId, accountKey)` is what makes a
        // second run over the same snapshot a new set instead of a conflict.
        const second = await prisma.integrationExecution.create({
            data: {
                tenantId: T1, connectionId: seeded[T1].connectionId, provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', status: 'PASSED',
                triggeredBy: 'manual', executedAt: new Date(), completedAt: new Date(),
            },
        });
        await prisma.legacyAccountResolution.create({
            data: {
                tenantId: T1, executionId: second.id, snapshotId: seeded[T1].snapshotId,
                accountKey: `acct-${T1}`, outcome: 'SUGGESTED', method: 'SUPPORTING_ONLY',
                signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });
        const rows = await prisma.legacyAccountResolution.findMany({
            where: { tenantId: T1, snapshotId: seeded[T1].snapshotId, accountKey: `acct-${T1}` },
        });
        expect(rows).toHaveLength(2);
        // And the FIRST one is untouched — a new run never rewrites an old verdict.
        const first = rows.find((r) => r.executionId === seeded[T1].executionId)!;
        expect(first.outcome).toBe('LINKED');
    });

    it('refuses two rows for one account in ONE run', async () => {
        await expect(
            prisma.legacyAccountResolution.create({
                data: {
                    tenantId: T1, executionId: seeded[T1].executionId,
                    snapshotId: seeded[T1].snapshotId, accountKey: `acct-${T1}`,
                    outcome: 'UNMATCHED', method: 'NO_CANDIDATES',
                    signalsJson: [], candidatesJson: [], vetoesJson: [],
                },
            })
        ).rejects.toThrow();
    });
});

describe('LegacyIdentityAlias — tenant isolation', () => {
    it('each tenant sees only its own aliases', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.legacyIdentityAlias.findMany({}));
            expect(rows.map((r) => r.accountKey)).toEqual([`acct-${t}`]);
        }
    });

    it('a tenant cannot read the other tenant alias — the strongest signal in the system', async () => {
        // A confirmed alias produces a LINKED on its own. One customer's
        // confirmation must never decide another customer's link.
        const row = await asTenant(T2, (tx) =>
            tx.legacyIdentityAlias.findUnique({ where: { id: seeded[T1].aliasId } })
        );
        expect(row).toBeNull();
    });

    it('a tenant cannot read another tenant alias by its natural key either', async () => {
        // The lookup the engine actually performs is by (connection, accountKey).
        const row = await asTenant(T2, (tx) =>
            tx.legacyIdentityAlias.findFirst({
                where: { connectionId: seeded[T1].connectionId, accountKey: `acct-${T1}` },
            })
        );
        expect(row).toBeNull();
    });

    it('refuses an INSERT claiming the other tenant', async () => {
        await expect(
            asTenant(T2, (tx) =>
                tx.legacyIdentityAlias.create({
                    data: {
                        tenantId: T1, connectionId: seeded[T1].connectionId,
                        accountKey: 'forged', employeeId: seeded[T1].employeeId,
                        method: 'CONFIRMED_ALIAS', confirmedAt: new Date(), signalsJson: [],
                    },
                })
            )
        ).rejects.toThrow();
    });

    it('an UPDATE of the other tenant alias changes ZERO rows, and it stays ACTIVE', async () => {
        // Suspending somebody else's alias would silently remove their strongest
        // signal, which is a denial of service dressed as a no-op.
        const res = await asTenant(T2, (tx) =>
            tx.legacyIdentityAlias.updateMany({
                where: { id: seeded[T1].aliasId },
                data: { status: 'SUSPENDED' },
            })
        );
        expect(res.count).toBe(0);
        const after = await prisma.legacyIdentityAlias.findUniqueOrThrow({
            where: { id: seeded[T1].aliasId },
        });
        expect(after.status).toBe('ACTIVE');
    });

    it('allows one alias per account per connection, and no rival', async () => {
        await expect(
            prisma.legacyIdentityAlias.create({
                data: {
                    tenantId: T1, connectionId: seeded[T1].connectionId,
                    accountKey: `acct-${T1}`, employeeId: seeded[T1].employeeId,
                    method: 'EMAIL_EXACT', confirmedAt: new Date(), signalsJson: [],
                },
            })
        ).rejects.toThrow();
    });
});
