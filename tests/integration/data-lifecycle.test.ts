/**
 * Data Lifecycle — Integration Tests
 *
 * Verifies:
 *   1. purgeSoftDeletedOlderThan only purges aged records
 *   2. Recently deleted records are NOT purged
 *   3. Active records are NOT purged
 *   4. purgeExpiredEvidenceOlderThan only purges long-archived evidence
 *   5. runRetentionSweep soft-deletes records with elapsed retentionUntil —
 *      and sweeps ONLY models whose retentionUntil something in src/ writes
 *   6. Audit events are emitted (DATA_PURGED, DATA_EXPIRED)
 *   7. dryRun does not mutate anything
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { withSoftDeleteExtension } from '@/lib/soft-delete';
import {
    purgeSoftDeletedOlderThan,
    runRetentionSweep,
} from '@/app-layer/jobs/data-lifecycle';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';

// Prisma 7 — soft-delete moved from `$use` to `$extends`. Wrap inline
// to mirror the production `src/lib/prisma.ts` composition.
const prisma = withPiiEncryptionExtension(
    withSoftDeleteExtension(
        new PrismaClient({
            adapter: new PrismaPg({ connectionString: DB_URL }),
        }),
    ),
);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const testTenantId = `dl-test-tenant-${Date.now()}`;
const testUserId = `dl-test-user-${Date.now()}`;

if (DB_AVAILABLE) {
    beforeAll(async () => {
        await prisma.tenant.create({
            data: { id: testTenantId, name: `DL Test ${Date.now()}`, slug: `dl-test-${Date.now()}` },
        });
        await prisma.user.create({
            data: { id: testUserId, email: `dl-test-${Date.now()}@example.com`, name: 'DL Test' },
        });
    });

    afterAll(async () => {
        // Clean up raw (bypass middleware)
        await prisma.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Risk" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Control" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Vendor" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Asset" WHERE "tenantId" = $1', testTenantId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE "id" = $1', testUserId).catch(() => {});
        await prisma.$executeRawUnsafe('DELETE FROM "Tenant" WHERE "id" = $1', testTenantId).catch(() => {});
        await prisma.$disconnect();
    });
}

describeFn('Data Lifecycle', () => {
    // ─── purgeSoftDeletedOlderThan ───

    describe('purgeSoftDeletedOlderThan', () => {
        it('purges records deleted beyond grace period', async () => {
            // Create a risk and soft-delete it with a very old deletedAt
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'Old deleted risk', category: 'OPERATIONAL' },
            });

            // Set deletedAt to 100 days ago via raw SQL
            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Risk" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, risk.id,
            );

            // Run purge with 90-day grace
            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const riskResult = results.find(r => r.model === 'Risk');
            expect(riskResult).toBeDefined();
            expect(riskResult!.purged).toBeGreaterThanOrEqual(1);

            // Verify hard-deleted
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Risk" WHERE "id" = $1', risk.id,
            );
            expect(rows).toHaveLength(0);
        });

        it('does NOT purge recently deleted records', async () => {
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'Recently deleted', category: 'COMPLIANCE' },
            });

            // Soft-delete it (deletedAt = now)
            await prisma.risk.delete({ where: { id: risk.id } });

            // Run purge with 90-day grace — should NOT purge
            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            // Verify still exists (soft-deleted but not purged)
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Risk" WHERE "id" = $1', risk.id,
            );
            expect(rows).toHaveLength(1);
        });

        it('does NOT purge active (non-deleted) records', async () => {
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'Active risk', category: 'STRATEGIC' },
            });

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 0, // Even with 0 grace, active records should not be touched
                db: prisma,
            });

            const found = await prisma.risk.findUnique({ where: { id: risk.id } });
            expect(found).not.toBeNull();
        });

        it('emits DATA_PURGED audit event', async () => {
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'Purge audit test', category: 'OPERATIONAL' },
            });

            const oldDate = new Date(Date.now() - 100 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Risk" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, risk.id,
            );

            await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                db: prisma,
            });

            const auditLogs = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId,
                    entityId: risk.id,
                    action: 'DATA_PURGED',
                },
            });

            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('soft_delete_grace_expired');
        });

        it('dryRun does not delete anything', async () => {
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'DryRun test', category: 'OPERATIONAL' },
            });

            const oldDate = new Date(Date.now() - 200 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Risk" SET "deletedAt" = $1 WHERE "id" = $2',
                oldDate, risk.id,
            );

            const results = await purgeSoftDeletedOlderThan({
                tenantId: testTenantId,
                graceDays: 90,
                dryRun: true,
                db: prisma,
            });

            const riskResult = results.find(r => r.model === 'Risk');
            expect(riskResult).toBeDefined();
            expect(riskResult!.scanned).toBeGreaterThanOrEqual(1);
            expect(riskResult!.purged).toBe(0);

            // Record still exists
            const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
                'SELECT "id" FROM "Risk" WHERE "id" = $1', risk.id,
            );
            expect(rows).toHaveLength(1);
        });
    });

    // ─── runRetentionSweep ───

    describe('runRetentionSweep', () => {
        // `Asset` is the only model the cross-model sweep acts on: it is the
        // only one whose `retentionUntil` anything in `src/` can write
        // (CreateAssetSchema / UpdateAssetSchema / BulkImportAssetsSchema →
        // usecases/asset.ts → the asset forms, CSV importer and public API).
        // `Evidence` has a writer too but is delegated to
        // runEvidenceRetentionSweep. Every other model with the column was
        // removed from RETENTION_MODELS — see the tests below.
        it('soft-deletes an Asset with an elapsed retentionUntil', async () => {
            const asset = await prisma.asset.create({
                data: { tenantId: testTenantId, type: 'SYSTEM', name: `Retention asset ${Date.now()}` },
            });
            const pastDate = new Date(Date.now() - 10 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Asset" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, asset.id,
            );

            const results = await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const assetResult = results.find(r => r.model === 'Asset');
            expect(assetResult).toBeDefined();
            expect(assetResult!.expired).toBeGreaterThanOrEqual(1);

            // Excluded by the soft-delete filter…
            expect(await prisma.asset.findUnique({ where: { id: asset.id } })).toBeNull();
            // …but raw SQL still has it, stamped.
            const [raw] = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
                'SELECT "deletedAt" FROM "Asset" WHERE "id" = $1', asset.id,
            );
            expect(raw).toBeDefined();
            expect(raw.deletedAt).not.toBeNull();
        });

        it('does NOT soft-delete an Asset with a future retentionUntil', async () => {
            const asset = await prisma.asset.create({
                data: { tenantId: testTenantId, type: 'SYSTEM', name: `Future asset ${Date.now()}` },
            });
            const futureDate = new Date(Date.now() + 365 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Asset" SET "retentionUntil" = $1 WHERE "id" = $2',
                futureDate, asset.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            expect(await prisma.asset.findUnique({ where: { id: asset.id } })).not.toBeNull();
        });

        it('emits DATA_EXPIRED audit events', async () => {
            const asset = await prisma.asset.create({
                data: { tenantId: testTenantId, type: 'SYSTEM', name: `Retention audit ${Date.now()}` },
            });
            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Asset" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, asset.id,
            );

            await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            const auditLogs = await prisma.auditLog.findMany({
                where: { tenantId: testTenantId, entityId: asset.id, action: 'DATA_EXPIRED' },
            });
            expect(auditLogs.length).toBeGreaterThanOrEqual(1);
            expect(auditLogs[0].details).toContain('retention_period_elapsed');
        });

        it('does not sweep models whose retentionUntil nothing in src/ can write', async () => {
            // Control was removed from RETENTION_MODELS on 2026-08-06; Risk,
            // Policy, Vendor, FileRecord and Task on 2026-08-12. Each has the
            // column, none has a writer — no Zod schema field, no DTO, no API
            // field, no UI, no job. Sweeping them was a guaranteed-empty query
            // run daily, backed by a retention doc claiming the dates were
            // enforced. The only thing that ever populated the column is the
            // raw SQL below — which is precisely why the gap survived.
            const control = await prisma.control.create({
                data: { tenantId: testTenantId, code: `WL-${Date.now()}`, name: 'Writer-less control' },
            });
            const vendor = await prisma.vendor.create({
                data: { tenantId: testTenantId, name: `Writer-less vendor ${Date.now()}` },
            });
            const risk = await prisma.risk.create({
                data: { tenantId: testTenantId, title: 'Writer-less risk', category: 'OPERATIONAL' },
            });
            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            for (const [table, id] of [['Control', control.id], ['Vendor', vendor.id], ['Risk', risk.id]] as const) {
                await prisma.$executeRawUnsafe(
                    `UPDATE "${table}" SET "retentionUntil" = $1 WHERE "id" = $2`, pastDate, id,
                );
            }

            const results = await runRetentionSweep({ tenantId: testTenantId, db: prisma });

            // Not scanned at all — no result entry for any of them.
            for (const model of ['Control', 'Vendor', 'Risk', 'Policy', 'FileRecord', 'Task']) {
                expect(results.find(r => r.model === model)).toBeUndefined();
            }
            // …and the rows are untouched: not soft-deleted, not audited.
            for (const [table, id] of [['Control', control.id], ['Vendor', vendor.id], ['Risk', risk.id]] as const) {
                const [raw] = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
                    `SELECT "deletedAt" FROM "${table}" WHERE "id" = $1`, id,
                );
                expect(raw.deletedAt).toBeNull();
            }
            const audits = await prisma.auditLog.findMany({
                where: {
                    tenantId: testTenantId, action: 'DATA_EXPIRED',
                    entityId: { in: [control.id, vendor.id, risk.id] },
                },
            });
            expect(audits).toHaveLength(0);
        });

        it('dryRun does not soft-delete', async () => {
            const asset = await prisma.asset.create({
                data: { tenantId: testTenantId, type: 'SYSTEM', name: `DryRun retention ${Date.now()}` },
            });
            const pastDate = new Date(Date.now() - 5 * 86_400_000);
            await prisma.$executeRawUnsafe(
                'UPDATE "Asset" SET "retentionUntil" = $1 WHERE "id" = $2',
                pastDate, asset.id,
            );

            const results = await runRetentionSweep({
                tenantId: testTenantId, dryRun: true, db: prisma,
            });

            expect(results.map(r => r.model)).toEqual(['Asset']);
            expect(await prisma.asset.findUnique({ where: { id: asset.id } })).not.toBeNull();
        });
    });
});
