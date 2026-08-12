/**
 * Branch coverage for the data-lifecycle purge + retention jobs
 * (`src/app-layer/jobs/data-lifecycle.ts`).
 *
 * DB-backed: each exported function takes an injectable `db` option
 * (`PurgeOptions.db`) so we pass prismaTestClient directly and seed
 * real soft-deleted / archived / retention-expired rows.
 *
 * Cross-link: the Evidence-specific archival sweep is in
 * `tests/unit/jobs/retention.test.ts`; this file covers the
 * cross-model lifecycle in data-lifecycle.ts.
 *
 * Branches exercised:
 *   purgeSoftDeletedOlderThan:
 *     - dryRun (scan only, no delete + no audit) vs real purge.
 *     - tenantId filter branch.
 *     - graceDays cutoff (a recently-deleted row is NOT purged).
 *     - found-rows → DELETE + DATA_PURGED audit per record.
 *   purgeExpiredEvidenceOlderThan:
 *     - dryRun vs real; only isArchived + expiredAt<cutoff eligible.
 *   runRetentionSweep:
 *     - Evidence skip branch (`model === 'Evidence'` → continue).
 *     - dryRun (expired = scanned) vs real soft-delete + DATA_EXPIRED.
 *     - retentionUntil cutoff + deletedAt=null filter.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../../integration/db-helper';
import { prismaTestClient } from '../../helpers/db';
import { withSoftDeleteExtension } from '@/lib/soft-delete';
import {
    purgeSoftDeletedOlderThan,
    purgeExpiredEvidenceOlderThan,
    runRetentionSweep,
    DEFAULT_SOFT_DELETE_GRACE_DAYS,
} from '@/app-layer/jobs/data-lifecycle';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `dl-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const LONG_AGO = new Date(NOW.getTime() - 200 * 86_400_000); // 200d before NOW
const RECENT = new Date(NOW.getTime() - 1 * 86_400_000); // 1d before NOW

describeFn('data-lifecycle jobs (real DB, injectable client)', () => {
    // Plain test client — used for seed/assert/cleanup.
    let prisma: PrismaClient;
    // The job calls `withDeleted()` which sets a magic key the soft-delete
    // extension strips before Prisma sees it. Production's `@/lib/prisma`
    // singleton wires that extension; the bare test client does not — so
    // we inject a soft-delete-aware wrapper as the job's `db`.
    let jobDb: PrismaClient;

    beforeAll(async () => {
        prisma = prismaTestClient();
        jobDb = withSoftDeleteExtension(prisma) as unknown as PrismaClient;
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
    });

    afterAll(async () => {
        await cleanup(prisma, TENANT);
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await cleanup(prisma, TENANT);
    });

    // ── purgeSoftDeletedOlderThan ────────────────────────────────────

    it('purges soft-deleted Risk rows older than the grace period and audits each', async () => {
        const old = await prisma.risk.create({
            data: { tenantId: TENANT, title: 'old', deletedAt: LONG_AGO },
        });
        // A recently-deleted row is inside the grace window → NOT purged.
        const recent = await prisma.risk.create({
            data: { tenantId: TENANT, title: 'recent', deletedAt: RECENT },
        });

        const results = await purgeSoftDeletedOlderThan({
            tenantId: TENANT,
            now: NOW,
            graceDays: DEFAULT_SOFT_DELETE_GRACE_DAYS,
            db: jobDb,
        });
        const risk = results.find((r) => r.model === 'Risk');
        expect(risk?.scanned).toBe(1);
        expect(risk?.purged).toBe(1);

        // old gone, recent stays
        expect(await rawExists(prisma, 'Risk', old.id)).toBe(false);
        expect(await rawExists(prisma, 'Risk', recent.id)).toBe(true);

        // DATA_PURGED audit written for the old row.
        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, action: 'DATA_PURGED', entityId: old.id },
        });
        expect(audit).toHaveLength(1);
    });

    it('dryRun scans but does not delete or audit', async () => {
        const old = await prisma.risk.create({
            data: { tenantId: TENANT, title: 'dry', deletedAt: LONG_AGO },
        });
        const results = await purgeSoftDeletedOlderThan({
            tenantId: TENANT, now: NOW, dryRun: true, db: jobDb,
        });
        const risk = results.find((r) => r.model === 'Risk');
        expect(risk?.scanned).toBe(1);
        expect(risk?.purged).toBe(0);
        expect(await rawExists(prisma, 'Risk', old.id)).toBe(true);
        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, action: 'DATA_PURGED' },
        });
        expect(audit).toHaveLength(0);
    });

    // ── purgeExpiredEvidenceOlderThan ────────────────────────────────

    it('hard-deletes archived+expired evidence past the grace period', async () => {
        const purgeable = await prisma.evidence.create({
            data: {
                tenantId: TENANT, type: 'FILE', title: 'purge-me',
                isArchived: true, expiredAt: LONG_AGO,
            },
        });
        // Archived but expired recently → not yet eligible.
        const tooRecent = await prisma.evidence.create({
            data: {
                tenantId: TENANT, type: 'FILE', title: 'keep',
                isArchived: true, expiredAt: RECENT,
            },
        });

        const res = await purgeExpiredEvidenceOlderThan({
            tenantId: TENANT, now: NOW, graceDays: 30, db: jobDb,
        });
        expect(res.model).toBe('Evidence');
        expect(res.scanned).toBe(1);
        expect(res.purged).toBe(1);
        expect(await rawExists(prisma, 'Evidence', purgeable.id)).toBe(false);
        expect(await rawExists(prisma, 'Evidence', tooRecent.id)).toBe(true);

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, action: 'DATA_PURGED', entityId: purgeable.id },
        });
        expect(audit).toHaveLength(1);
    });

    it('purgeExpiredEvidence dryRun scans without deleting', async () => {
        const ev = await prisma.evidence.create({
            data: {
                tenantId: TENANT, type: 'FILE', title: 'dry-ev',
                isArchived: true, expiredAt: LONG_AGO,
            },
        });
        const res = await purgeExpiredEvidenceOlderThan({
            tenantId: TENANT, now: NOW, graceDays: 30, dryRun: true, db: jobDb,
        });
        expect(res.scanned).toBe(1);
        expect(res.purged).toBe(0);
        expect(await rawExists(prisma, 'Evidence', ev.id)).toBe(true);
    });

    // ── runRetentionSweep ────────────────────────────────────────────

    it('soft-deletes retention-expired Assets and skips Evidence (its own sweep)', async () => {
        // Asset is the only model in RETENTION_MODELS the cross-model loop
        // acts on — it is the only one with a product writer for
        // `retentionUntil` (CreateAssetSchema/UpdateAssetSchema → usecases/asset.ts).
        const expiredAsset = await prisma.asset.create({
            data: { tenantId: TENANT, type: 'SYSTEM', name: 'expired', retentionUntil: LONG_AGO, deletedAt: null },
        });
        // Evidence is intentionally skipped by the cross-model sweep.
        const ev = await prisma.evidence.create({
            data: {
                tenantId: TENANT, type: 'FILE', title: 'ev-skip',
                retentionUntil: LONG_AGO, deletedAt: null, isArchived: false,
            },
        });
        // A Risk with an expired retention date is NOT swept: Risk was removed
        // from RETENTION_MODELS (no writer anywhere in src/). Only raw SQL can
        // even set the column — which is why the gap survived so long.
        const risk = await prisma.risk.create({
            data: { tenantId: TENANT, title: 'writerless', deletedAt: null },
        });
        await prisma.$executeRawUnsafe(
            `UPDATE "Risk" SET "retentionUntil" = $1 WHERE id = $2`, LONG_AGO, risk.id,
        );

        const results = await runRetentionSweep({ tenantId: TENANT, now: NOW, db: jobDb });
        // No 'Evidence' entry — the `continue` branch.
        expect(results.find((r) => r.model === 'Evidence')).toBeUndefined();
        // No 'Risk' entry — not in RETENTION_MODELS at all.
        expect(results.find((r) => r.model === 'Risk')).toBeUndefined();
        expect(results.map((r) => r.model)).toEqual(['Asset']);
        const asset = results.find((r) => r.model === 'Asset');
        expect(asset?.scanned).toBe(1);
        expect(asset?.expired).toBe(1);

        // Asset got soft-deleted; Evidence + Risk untouched by this sweep.
        const assetRows = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
            `SELECT "deletedAt" FROM "Asset" WHERE id = $1`, expiredAsset.id,
        );
        expect(assetRows[0].deletedAt).not.toBeNull();
        const evRows = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
            `SELECT "deletedAt" FROM "Evidence" WHERE id = $1`, ev.id,
        );
        expect(evRows[0].deletedAt).toBeNull();
        const riskRows = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
            `SELECT "deletedAt" FROM "Risk" WHERE id = $1`, risk.id,
        );
        expect(riskRows[0].deletedAt).toBeNull();

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, action: 'DATA_EXPIRED', entityId: expiredAsset.id },
        });
        expect(audit).toHaveLength(1);
        const riskAudit = await prisma.auditLog.findMany({
            where: { tenantId: TENANT, action: 'DATA_EXPIRED', entityId: risk.id },
        });
        expect(riskAudit).toHaveLength(0);
    });

    it('runRetentionSweep dryRun reports expired = scanned and writes nothing', async () => {
        const a = await prisma.asset.create({
            data: { tenantId: TENANT, type: 'SYSTEM', name: 'dry-sweep', retentionUntil: LONG_AGO, deletedAt: null },
        });
        const results = await runRetentionSweep({ tenantId: TENANT, now: NOW, dryRun: true, db: jobDb });
        const asset = results.find((res) => res.model === 'Asset');
        expect(asset?.scanned).toBe(1);
        expect(asset?.expired).toBe(1); // dryRun → expired mirrors scanned

        const rows = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
            `SELECT "deletedAt" FROM "Asset" WHERE id = $1`, a.id,
        );
        expect(rows[0].deletedAt).toBeNull(); // not actually soft-deleted
    });
});

async function rawExists(prisma: PrismaClient, table: string, id: string): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "${table}" WHERE id = $1`, id,
    );
    return rows.length > 0;
}

async function cleanup(prisma: PrismaClient, tenantId: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, tenantId);
    });
    await prisma.evidence.deleteMany({ where: { tenantId } });
    await prisma.$executeRawUnsafe(`DELETE FROM "Risk" WHERE "tenantId" = $1`, tenantId);
    await prisma.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "tenantId" = $1`, tenantId);
}
