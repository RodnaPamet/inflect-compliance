/**
 * Integration test: the nightly audit-pack snapshot encryption job (#5455),
 * against a real database.
 *
 * The rows are seeded with RAW SQL on purpose. A plaintext snapshot is exactly
 * what the extended client can no longer write since #5150, so the only honest
 * way to stand one up is the way the old rows were left: unenveloped text in
 * the column.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup, encryptWithKey, decryptWithKey } from '@/lib/security/encryption';
import { createTenantWithDek, _resetTenantDekCache } from '@/lib/security/tenant-key-manager';
import { generateDek, wrapDek, unwrapDek } from '@/lib/security/tenant-keys';
import { runWithAuditContext } from '@/lib/audit-context';
import appPrisma from '@/lib/prisma';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import {
    runAuditPackSnapshotEncryptionSweep,
    encryptTenantAuditPackSnapshots,
} from '@/app-layer/jobs/audit-pack-snapshot-encryption';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `apse-${randomUUID().slice(0, 8)}`;
const USER = `u-${SUITE}`;
const WITH_DEK = `t-${SUITE}-a`;
const WITHOUT_DEK = `t-${SUITE}-b`;
const MID_ROTATION = `t-${SUITE}-c`;
const TENANTS = [WITH_DEK, WITHOUT_DEK, MID_ROTATION];

const SECRET = JSON.stringify({
    kind: 'TEST_RUN',
    notes: 'tester notes that must not sit in clear',
    findingSummary: 'the finding summary',
    executedBy: { email: 'tester@example.test' },
});

async function seedPack(tenantId: string): Promise<string> {
    const cycle = await prisma.auditCycle.create({
        data: { tenant: { connect: { id: tenantId } }, frameworkKey: 'iso27001', frameworkVersion: '2022', name: 'Cycle', createdBy: { connect: { id: USER } } },
    });
    const pack = await prisma.auditPack.create({
        data: { tenant: { connect: { id: tenantId } }, cycle: { connect: { id: cycle.id } }, name: 'Pack' },
    });
    return pack.id;
}

/** Insert a snapshot exactly as given — no middleware, no envelope added. */
async function insertRawItem(tenantId: string, packId: string, snapshotJson: string): Promise<string> {
    const id = `i-${randomUUID()}`;
    await prisma.$executeRawUnsafe(
        `INSERT INTO "AuditPackItem" (id, "tenantId", "auditPackId", "entityType", "entityId", "snapshotJson")
         VALUES ($1, $2, $3, 'TEST_RUN', $4, $5)`,
        id,
        tenantId,
        packId,
        `e-${randomUUID()}`,
        snapshotJson,
    );
    return id;
}

async function rawSnapshot(id: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
        `SELECT "snapshotJson" AS v FROM "AuditPackItem" WHERE id = $1`,
        id,
    );
    return rows[0].v;
}

async function tenantDek(tenantId: string): Promise<Buffer> {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { encryptedDek: true } });
    return unwrapDek(t.encryptedDek!);
}

describeFn('audit-pack-snapshot-encryption (#5455)', () => {
    beforeAll(async () => {
        await createTenantWithDek({ id: WITH_DEK, name: `${SUITE}-a`, slug: `${SUITE}-a` });
        // A tenant born before per-tenant DEKs: no key yet.
        await prisma.tenant.create({ data: { id: WITHOUT_DEK, name: `${SUITE}-b`, slug: `${SUITE}-b` } });
        await createTenantWithDek({ id: MID_ROTATION, name: `${SUITE}-c`, slug: `${SUITE}-c` });
        const email = `${SUITE}@example.test`;
        await prisma.user.create({ data: { id: USER, email, emailHash: hashForLookup(email) } });
    });

    beforeEach(() => _resetTenantDekCache());

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => undefined);
        await prisma.auditPackItem.deleteMany({ where: { tenantId: { in: TENANTS } } });
        await prisma.auditPack.deleteMany({ where: { tenantId: { in: TENANTS } } });
        await prisma.auditCycle.deleteMany({ where: { tenantId: { in: TENANTS } } });
        await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
        await prisma.user.deleteMany({ where: { id: USER } });
        await prisma.$disconnect();
    });

    it('encrypts a plaintext snapshot under its own tenant DEK, leaves other tenants alone, and reports the column', async () => {
        const packA = await seedPack(WITH_DEK);
        const packB = await seedPack(WITHOUT_DEK);
        const plain = await insertRawItem(WITH_DEK, packA, SECRET);
        const empty = await insertRawItem(WITH_DEK, packA, '');
        const already = await insertRawItem(WITH_DEK, packA, encryptWithKey(await tenantDek(WITH_DEK), '{"kind":"FILE"}'));
        const other = await insertRawItem(WITHOUT_DEK, packB, SECRET);
        const alreadyBefore = await rawSnapshot(already);

        const r = await runAuditPackSnapshotEncryptionSweep({ tenantId: WITH_DEK });

        expect(r.before).toEqual({ total: 3, plaintext: 1, v2: 1, v1: 0, empty: 1 });
        expect(r.after).toEqual({ total: 3, plaintext: 0, v2: 2, v1: 0, empty: 1 });
        expect(r.tenants).toEqual([
            expect.objectContaining({ tenantId: WITH_DEK, outcome: 'ENCRYPTED', scanned: 1, encrypted: 1, errors: 0, remaining: 0 }),
        ]);

        // At rest: a v2 envelope that opens under THIS tenant's DEK.
        const stored = await rawSnapshot(plain);
        expect(stored.startsWith('v2:')).toBe(true);
        expect(stored).not.toContain('tester notes');
        expect(decryptWithKey(await tenantDek(WITH_DEK), stored)).toBe(SECRET);

        // Through the application's read path, the snapshot reads as it did.
        const viaApp = await runWithAuditContext({ tenantId: WITH_DEK, source: 'api' }, async () =>
            appPrisma.auditPackItem.findUniqueOrThrow({ where: { id: plain }, select: { snapshotJson: true } }),
        );
        expect(viaApp.snapshotJson).toBe(SECRET);

        // Untouched: the empty snapshot, the row already encrypted, the other tenant.
        expect(await rawSnapshot(empty)).toBe('');
        expect(await rawSnapshot(already)).toBe(alreadyBefore);
        expect(await rawSnapshot(other)).toBe(SECRET);

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: WITH_DEK, action: 'AUDIT_PACK_SNAPSHOTS_ENCRYPTED' },
            select: { actorType: true, userId: true },
        });
        expect(audit).toEqual([{ actorType: 'SYSTEM', userId: null }]);

        // Idempotent: a second run finds no plaintext and visits no tenant,
        // and says so with the numbers rather than with silence.
        const again = await runAuditPackSnapshotEncryptionSweep({ tenantId: WITH_DEK });
        expect(again.tenants).toEqual([]);
        expect(again.before).toEqual({ total: 3, plaintext: 0, v2: 2, v1: 0, empty: 1 });
    });

    it('gives a tenant with no DEK one first, then encrypts under it', async () => {
        const before = await prisma.tenant.findUniqueOrThrow({ where: { id: WITHOUT_DEK }, select: { encryptedDek: true } });
        expect(before.encryptedDek).toBeNull();

        const r = await encryptTenantAuditPackSnapshots(WITHOUT_DEK);

        expect(r).toEqual(expect.objectContaining({ outcome: 'ENCRYPTED', encrypted: 1, remaining: 0 }));
        const rows = await prisma.$queryRawUnsafe<Array<{ v: string }>>(
            `SELECT "snapshotJson" AS v FROM "AuditPackItem" WHERE "tenantId" = $1`,
            WITHOUT_DEK,
        );
        expect(rows).toHaveLength(1);
        expect(decryptWithKey(await tenantDek(WITHOUT_DEK), rows[0].v)).toBe(SECRET);
    });

    it('does not touch a tenant whose DEK rotation is in flight, and reports what it left', async () => {
        const pack = await seedPack(MID_ROTATION);
        const plain = await insertRawItem(MID_ROTATION, pack, SECRET);
        await prisma.tenant.update({ where: { id: MID_ROTATION }, data: { previousEncryptedDek: wrapDek(generateDek()) } });

        const r = await encryptTenantAuditPackSnapshots(MID_ROTATION);

        expect(r).toEqual(expect.objectContaining({ outcome: 'ROTATION_IN_FLIGHT', scanned: 0, encrypted: 0, remaining: 1 }));
        expect(await rawSnapshot(plain)).toBe(SECRET);
    });

    it('waits for a rotation that starts during the pass, then stops without writing under the old key', async () => {
        // The race this guards: the pass reads the DEK, a rotation swaps it and
        // its sweep runs, and the pass then writes under the key the sweep is
        // about to throw away. Here the rotation's UPDATE is held open on the
        // tenant row; the pass must block on its FOR SHARE, then see the swap.
        const tenantId = `t-${SUITE}-d`;
        TENANTS.push(tenantId);
        await createTenantWithDek({ id: tenantId, name: `${SUITE}-d`, slug: `${SUITE}-d` });
        const pack = await seedPack(tenantId);
        const plain = await insertRawItem(tenantId, pack, SECRET);
        const oldWrapped = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { encryptedDek: true } })).encryptedDek!;

        const rotator = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
        let pass: Promise<Awaited<ReturnType<typeof encryptTenantAuditPackSnapshots>>> | undefined;
        try {
            await rotator.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `UPDATE "Tenant" SET "previousEncryptedDek" = "encryptedDek", "encryptedDek" = $2 WHERE id = $1`,
                    tenantId,
                    wrapDek(generateDek()),
                );
                pass = encryptTenantAuditPackSnapshots(tenantId);
                // Hold the swap open until the pass is provably waiting on the
                // tenant row's lock, never for a guessed number of milliseconds.
                for (let i = 0; i < 100; i++) {
                    const waiting = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                        `SELECT count(*) AS n FROM pg_stat_activity
                         WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "Tenant" WHERE id = $1 FOR SHARE%'`,
                    );
                    if (Number(waiting[0].n) > 0) return;
                    await new Promise((r) => setTimeout(r, 50));
                }
                throw new Error('the pass never blocked on the tenant row');
            }, { timeout: 15_000 });

            const r = await pass!;
            expect(r).toEqual(expect.objectContaining({ outcome: 'KEY_CHANGED', encrypted: 0, remaining: 1 }));
            expect(await rawSnapshot(plain)).toBe(SECRET);
            // And the key it would have used is the one now in the previous slot.
            const after = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { previousEncryptedDek: true } });
            expect(after.previousEncryptedDek).toBe(oldWrapped);
        } finally {
            await pass?.catch(() => undefined);
            await rotator.$disconnect();
        }
    });

    it('a tenant pass reached by the scheduled sweep is one of the tenants it discovers', async () => {
        // The unscoped sweep runs over the whole table, so assert only on this
        // suite's tenant: it holds the one plaintext row left (the rotation).
        const r = await runAuditPackSnapshotEncryptionSweep({});
        expect(r.tenants).toContainEqual(expect.objectContaining({ tenantId: MID_ROTATION, outcome: 'ROTATION_IN_FLIGHT', remaining: 1 }));
        expect(r.tenants.map((t) => t.tenantId)).not.toContain(WITH_DEK);
        expect(r.after.plaintext).toBeGreaterThanOrEqual(1);
    });

    it('is scheduled daily, runs once per tick, and has an executor', () => {
        expect(SCHEDULED_JOBS.find((j) => j.name === 'audit-pack-snapshot-encryption')?.pattern).toBe('23 2 * * *');
        expect(JOB_DEFAULTS['audit-pack-snapshot-encryption'].attempts).toBe(1);
        expect(executorRegistry.has('audit-pack-snapshot-encryption')).toBe(true);
    });
});
