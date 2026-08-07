/**
 * Retention Purge Job
 *
 * Permanently removes soft-deleted records that are older than a specified
 * number of days. Runs as a system/admin job — hookable via cron.
 *
 * Usage:
 *   npx ts-node -e "import { purgeSoftDeletedOlderThan } from './src/lib/retention-purge'; purgeSoftDeletedOlderThan(90).then(console.log)"
 *
 * Or from a cron handler:
 *   import { purgeSoftDeletedOlderThan } from '@/lib/retention-purge';
 *   const result = await purgeSoftDeletedOlderThan(90);
 */
import { prisma } from './prisma';
import { SOFT_DELETE_MODELS } from './soft-delete';
import { logger } from '@/lib/observability/logger';

export interface PurgeResult {
    totalPurged: number;
    perModel: Record<string, number>;
    cutoffDate: Date;
    durationMs: number;
}

/**
 * Purge all soft-deleted records older than `days` days.
 *
 * @param days - Number of days after which soft-deleted records are purged
 * @returns Summary of purged records per model
 */
/**
 * Soft-delete models that also carry GLOBAL (tenantId IS NULL) rows.
 *
 * Kept explicit rather than derived at runtime so adding a nullable-tenant
 * model to SOFT_DELETE_MODELS is a decision someone makes, not a default
 * they inherit. If this set and the schema ever disagree, the test in
 * tests/unit/retention-purge-global-rows.test.ts fails.
 */
const NULLABLE_TENANT_MODELS = new Set<string>(['Control']);

export async function purgeSoftDeletedOlderThan(days: number): Promise<PurgeResult> {
    if (days < 1) throw new Error('Retention days must be at least 1');

    const start = Date.now();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const perModel: Record<string, number> = {};
    let totalPurged = 0;

    for (const model of SOFT_DELETE_MODELS) {
        // Models whose tenantId is NULLABLE also hold GLOBAL rows — the
        // shared library every tenant reads. A purge with no tenant
        // predicate would hard-delete those platform-wide on one tenant's
        // retention clock.
        //
        // `Control` is the only such model in SOFT_DELETE_MODELS today
        // (verified against the schema). It was unreachable in practice
        // because deleteControl refuses to soft-delete globals — but that is
        // one guard deep, in a different file, and nothing connected the
        // two. This predicate makes the purge safe on its own terms.
        const globalRowsGuard = NULLABLE_TENANT_MODELS.has(model)
            ? ' AND "tenantId" IS NOT NULL'
            : '';

        // Use raw SQL to bypass soft-delete middleware
        const result = await prisma.$executeRawUnsafe(
            `DELETE FROM "${model}" WHERE "deletedAt" IS NOT NULL AND "deletedAt" < $1${globalRowsGuard}`,
            cutoff,
        );
        perModel[model] = result;
        totalPurged += result;
    }

    // Log the purge event via hash-chained writer
    if (totalPurged > 0) {
        try {
            // Get first tenant for system-level event
            const firstTenant: Array<{ id: string }> = await prisma.$queryRawUnsafe(
                `SELECT "id" FROM "Tenant" LIMIT 1`
            );
            if (firstTenant.length > 0) {
                const { appendAuditEntry } = require('./audit/audit-writer');
                await appendAuditEntry({
                    tenantId: firstTenant[0].id,
                    userId: null,
                    actorType: 'JOB',
                    entity: 'System',
                    entityId: 'retention-purge',
                    action: 'PURGE_EXECUTED',
                    details: `Retention purge: ${totalPurged} records older than ${days} days`,
                    metadataJson: { totalPurged, perModel, cutoffDate: cutoff.toISOString(), days },
                });
            }
        } catch {
            // Best effort — don't fail the purge if audit log fails
            logger.warn('Failed to write audit log for retention purge', { component: 'retention-purge' });
        }
    }

    const durationMs = Date.now() - start;

    logger.info('Retention purge completed', {
        component: 'retention-purge',
        totalPurged,
        cutoff: cutoff.toISOString(),
        durationMs,
        perModel: Object.fromEntries(Object.entries(perModel).filter(([, c]) => c > 0)),
    });

    return { totalPurged, perModel, cutoffDate: cutoff, durationMs };
}
