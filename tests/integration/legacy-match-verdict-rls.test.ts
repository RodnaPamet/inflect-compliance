/**
 * Two-tenant isolation and the shape constraint for `LegacyMatchVerdict`.
 *
 * Registered in `tests/guardrails/tenant-isolation-forward-lock.test.ts`, which
 * is what obliges a new tenant table to have a BEHAVIOURAL test rather than only
 * an RLS block somebody read in a migration.
 *
 * The shape constraint gets the same treatment, and for the same reason it is a
 * CHECK rather than a usecase rule: a backfill, a repair script and a future
 * caller are exactly the writers a usecase check does not cover.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();
const T1 = 'lmv-one';
const T2 = 'lmv-two';

const seeded: Record<string, { resolutionId: string; verdictId: string }> = {};

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.legacyMatchVerdict.deleteMany({ where: t });
    await prisma.legacyAccountResolution.deleteMany({ where: t });
    await prisma.legacyAccessSnapshot.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name, slug: id } });
        const conn = await prisma.integrationConnection.create({
            data: { tenantId: id, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
        });
        const snap = await prisma.legacyAccessSnapshot.create({
            data: {
                tenantId: id, connectionId: conn.id, remoteSnapshotId: `s-${id}`,
                mappingVersion: 1, columnSetFingerprint: 'f'.repeat(64),
                payloadHash: 'h'.repeat(64), rowCount: 1, rowsReceived: 1,
                status: 'COMPLETE', completedAt: new Date(),
            },
        });
        const exec = await prisma.integrationExecution.create({
            data: {
                tenantId: id, connectionId: conn.id, status: 'PASSED', provider: 'legacy-mcp',
                automationKey: 'legacy-mcp.reconcile', executedAt: new Date(), completedAt: new Date(),
            },
        });
        const res = await prisma.legacyAccountResolution.create({
            data: {
                tenantId: id, executionId: exec.id, snapshotId: snap.id,
                accountKey: 'jsmith', outcome: 'SUGGESTED', method: 'SUPPORTING_ONLY',
                signalsJson: [], candidatesJson: [], vetoesJson: [],
            },
        });
        const v = await prisma.legacyMatchVerdict.create({
            data: {
                tenantId: id, resolutionId: res.id,
                modelId: 'jev', modelRevision: `rev-${id}`,
                verdict: 'AGREES', personProbability: 0.95,
                topProbability: 0.96, topMargin: 0.5,
                probabilitiesJson: { A: 0.96, B: 0.02 },
                latencyMs: 120, inputTokens: 800,
            },
        });
        seeded[id] = { resolutionId: res.id, verdictId: v.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('two-tenant isolation', () => {
    it('a tenant reads only its own verdicts', async () => {
        const mine = await asTenant(T1, (tx) => tx.legacyMatchVerdict.findMany({}));
        expect(mine.map((v) => v.id)).toEqual([seeded[T1].verdictId]);
        // The denominator: the other row EXISTS, so the single result above is
        // isolation rather than an almost-empty table.
        const theirs = await asTenant(T2, (tx) => tx.legacyMatchVerdict.findMany({}));
        expect(theirs.map((v) => v.id)).toEqual([seeded[T2].verdictId]);
    });

    it('a cross-tenant read by id returns nothing', async () => {
        const row = await asTenant(T1, (tx) =>
            tx.legacyMatchVerdict.findFirst({ where: { id: seeded[T2].verdictId } })
        );
        expect(row).toBeNull();
    });

    it('a cross-tenant DELETE removes nothing, and says so by COUNT', async () => {
        // A DELETE under RLS removes zero rows silently when SELECT hides them,
        // so the count is the only honest assertion — "the call returned" would
        // pass either way.
        const r = await asTenant(T1, (tx) =>
            tx.legacyMatchVerdict.deleteMany({ where: { id: seeded[T2].verdictId } })
        );
        expect(r.count).toBe(0);
        expect(
            await prisma.legacyMatchVerdict.count({ where: { id: seeded[T2].verdictId } })
        ).toBe(1);
    });
});

describe('the outcome shape constraint', () => {
    it('a verdict WITH a non-verdict reason is refused', async () => {
        await expect(
            prisma.legacyMatchVerdict.create({
                data: {
                    tenantId: T1, resolutionId: seeded[T1].resolutionId,
                    modelId: 'jev', modelRevision: 'both',
                    verdict: 'UNSURE', nonVerdictReason: 'TIMEOUT',
                },
            })
        ).rejects.toThrow(/outcome_shape/);
    });

    it('a row with NEITHER is refused — a question nobody asked', async () => {
        await expect(
            prisma.legacyMatchVerdict.create({
                data: {
                    tenantId: T1, resolutionId: seeded[T1].resolutionId,
                    modelId: 'jev', modelRevision: 'neither',
                },
            })
        ).rejects.toThrow(/outcome_shape/);
    });

    it('a non-verdict reason alone is accepted', async () => {
        const v = await prisma.legacyMatchVerdict.create({
            data: {
                tenantId: T1, resolutionId: seeded[T1].resolutionId,
                modelId: 'jev', modelRevision: 'reason-only',
                nonVerdictReason: 'NO_EVALUATION',
            },
        });
        expect(v.verdict).toBeNull();
        expect(v.nonVerdictReason).toBe('NO_EVALUATION');
    });
});

describe('one answer per question', () => {
    it('a second verdict for the same resolution AND revision collides', async () => {
        await expect(
            prisma.legacyMatchVerdict.create({
                data: {
                    tenantId: T1, resolutionId: seeded[T1].resolutionId,
                    modelId: 'jev', modelRevision: `rev-${T1}`,
                    verdict: 'UNSURE',
                },
            })
        ).rejects.toThrow();
    });

    it('but a NEW revision is an addition, not a collision', async () => {
        // What makes "what did revision X say about this account" answerable
        // after a model change.
        const v = await prisma.legacyMatchVerdict.create({
            data: {
                tenantId: T1, resolutionId: seeded[T1].resolutionId,
                modelId: 'jev', modelRevision: 'rev-next',
                verdict: 'PROPOSES', personProbability: 0.9,
                topProbability: 0.93, topMargin: 0.4,
            },
        });
        expect(v.modelRevision).toBe('rev-next');
        expect(
            await prisma.legacyMatchVerdict.count({
                where: { tenantId: T1, resolutionId: seeded[T1].resolutionId },
            })
        ).toBeGreaterThanOrEqual(2);
    });
});
