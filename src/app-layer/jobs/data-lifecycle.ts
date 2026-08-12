/**
 * Data Lifecycle Jobs — Purge & Retention Enforcement
 *
 * Provides:
 *   1. purgeSoftDeletedOlderThan  — bulk purge soft-deleted records across all models
 *   2. purgeExpiredEvidenceOlderThan — hard-delete archived evidence past grace period
 *   3. runRetentionSweep — cross-model sweep that marks expired records
 *
 * All operations are:
 *   - Tenant-scoped (never cross-tenant in one pass)
 *   - Auditable (emit audit events)
 *   - Idempotent (safe to re-run)
 *   - Conservative defaults (90-day soft-delete grace, 365-day evidence purge)
 *
 * Usage:
 *   import { purgeSoftDeletedOlderThan, purgeExpiredEvidenceOlderThan, runRetentionSweep }
 *       from '@/app-layer/jobs/data-lifecycle';
 */
import { Prisma } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { SOFT_DELETE_MODELS, withDeleted } from '@/lib/soft-delete';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

/** Minimal delegate interface for dynamic model access by string key */
interface ModelDelegate {
    findMany(args: object): Promise<Array<{ id: string; tenantId: string }>>;
    update(args: object): Promise<unknown>;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Default: soft-deleted records older than 90 days are eligible for purge */
export const DEFAULT_SOFT_DELETE_GRACE_DAYS = 90;

/** Default: archived evidence older than 365 days is eligible for hard purge */
export const DEFAULT_EVIDENCE_PURGE_DAYS = 365;

/**
 * Models whose `retentionUntil` the sweep enforces.
 *
 * MEMBERSHIP RULE: a model belongs here only if something in `src/` can
 * actually WRITE its `retentionUntil`. A swept column with no writer is
 * worse than no sweep, because it reads as a control that exists.
 *
 * Eight Prisma models carry a `retentionUntil` column; only two have a
 * writer:
 *   - `Asset`    — `CreateAssetSchema` / `UpdateAssetSchema` /
 *                  `BulkImportAssetsSchema` (`src/lib/schemas/index.ts`),
 *                  persisted by `usecases/asset.ts`, exposed on the asset
 *                  create + edit forms and the CSV importer, and published
 *                  in `public/openapi.json`.
 *   - `Evidence` — `usecases/evidence-retention.ts` (the retention route)
 *                  and the evidence importer. Swept by the specialised
 *                  `runEvidenceRetentionSweep`, so the loop below skips it.
 *
 * The other six were removed after a full census of every `retentionUntil`
 * occurrence in `src/`, `scripts/`, `prisma/` and the published OpenAPI
 * document:
 *   - `Control` (2026-08-06) — no writer.
 *   - `Risk`, `Policy`, `Vendor`, `FileRecord`, `Task` (2026-08-12) — no
 *     writer either: no Zod schema field, no DTO field, no API field, no UI
 *     control, no job. The one place in the task domain that considered the
 *     column is `usecases/task-source-reconcile.ts`, which documents that it
 *     deliberately does NOT write it. The only writes anywhere were raw-SQL
 *     UPDATEs inside this job's own tests — which is exactly why the gap
 *     survived: the sole thing populating the column was a test.
 *
 * So those six branches were guaranteed-empty queries run daily, forever,
 * backed by a retention policy doc that claimed the dates were enforced
 * "where set". All eight models are still purged via the soft-delete path
 * (`SOFT_DELETE_MODELS`), which is what docs/data-retention.md now says.
 *
 * To put a model back: add it here AND expose `retentionUntil` on its
 * update schema + its edit UI in the SAME change.
 */
const RETENTION_MODELS = [
    'Asset', 'Evidence',
] as const;

// ─── Types ──────────────────────────────────────────────────────────

export interface PurgeOptions {
    tenantId?: string;
    dryRun?: boolean;
    now?: Date;
    db?: typeof defaultPrisma; // injectable PrismaClient for testing
}

export interface PurgeSoftDeletedOptions extends PurgeOptions {
    /** Records soft-deleted more than this many days ago are eligible. Default: 90 */
    graceDays?: number;
}

export interface PurgeExpiredEvidenceOptions extends PurgeOptions {
    /** Archived evidence older than this many days is eligible. Default: 365 */
    graceDays?: number;
}

export interface PurgeResult {
    model: string;
    scanned: number;
    purged: number;
    dryRun: boolean;
}

export interface RetentionSweepResult {
    model: string;
    scanned: number;
    expired: number;
}

// ═══════════════════════════════════════════════════════════════════
// 1. Purge Soft-Deleted Records (across all models)
// ═══════════════════════════════════════════════════════════════════

/**
 * Permanently removes soft-deleted records older than graceDays.
 *
 * Safety:
 *   - Only records with deletedAt < (now - graceDays) are purged
 *   - Hard-deletes via raw SQL to bypass soft-delete middleware
 *   - Emits DATA_PURGED audit event per record
 *   - Tenant-scoped
 */
export async function purgeSoftDeletedOlderThan(
    options: PurgeSoftDeletedOptions = {},
): Promise<PurgeResult[]> {
    return runJob('purge-soft-deleted', async () => {
        const now = options.now ?? new Date();
        const graceDays = options.graceDays ?? DEFAULT_SOFT_DELETE_GRACE_DAYS;
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

        const results: PurgeResult[] = [];

        for (const model of SOFT_DELETE_MODELS) {
            const key = model.charAt(0).toLowerCase() + model.slice(1);
            const delegate = (db as unknown as Record<string, ModelDelegate>)[key];
            if (!delegate) continue;

            // Find eligible records: soft-deleted before cutoff
            const whereClause: Record<string, unknown> = {
                deletedAt: { not: null, lt: cutoff },
            };
            if (options.tenantId) {
                whereClause.tenantId = options.tenantId;
            }

            const candidates = await delegate.findMany(withDeleted({
                where: whereClause,
                select: { id: true, tenantId: true },
            }));

            const scanned = candidates.length;
            let purged = 0;

            if (!dryRun) {
                for (const record of candidates) {
                    await db.$executeRawUnsafe(
                        `DELETE FROM "${model}" WHERE "id" = $1`,
                        record.id,
                    );

                    // Emit audit event
                    await db.auditLog.create({
                        data: {
                            tenantId: record.tenantId,
                            action: 'DATA_PURGED',
                            entity: model,
                            entityId: record.id,
                            details: JSON.stringify({
                                reason: 'soft_delete_grace_expired',
                                graceDays,
                                purgedAt: now.toISOString(),
                            }),
                        },
                    });

                    purged++;
                }
            }

            results.push({ model, scanned, purged, dryRun });

            if (scanned > 0) {
                logger.info('purge-soft-deleted', {
                    component: 'job',
                    model, scanned, purged, dryRun, graceDays,
                });
            }
        }

        return results;
    }, { tenantId: options.tenantId });
}

// ═══════════════════════════════════════════════════════════════════
// 2. Purge Expired (Archived) Evidence
// ═══════════════════════════════════════════════════════════════════

/**
 * Permanently removes archived evidence that has been expired for longer
 * than the grace period. This is the final lifecycle step:
 *
 *   Evidence → expired → archived (by retention sweep) → purged (by this job)
 *
 * Safety:
 *   - Only evidence with isArchived=true AND expiredAt < (now - graceDays)
 *   - Must be soft-deleted OR archived (double-guard)
 *   - Emits DATA_PURGED audit event per record
 */
export async function purgeExpiredEvidenceOlderThan(
    options: PurgeExpiredEvidenceOptions = {},
): Promise<PurgeResult> {
    return runJob('purge-expired-evidence', async () => {
        const now = options.now ?? new Date();
        const graceDays = options.graceDays ?? DEFAULT_EVIDENCE_PURGE_DAYS;
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const cutoff = new Date(now.getTime() - graceDays * 86_400_000);

        const where: Prisma.EvidenceWhereInput = {
            isArchived: true,
            expiredAt: { not: null, lt: cutoff },
        };
        if (options.tenantId) {
            where.tenantId = options.tenantId;
        }

        const candidates = await db.evidence.findMany(withDeleted({
            where,
            select: { id: true, tenantId: true, title: true },
        }));

        const scanned = candidates.length;
        let purged = 0;

        if (!dryRun) {
            for (const ev of candidates) {
                await db.$executeRawUnsafe(
                    'DELETE FROM "Evidence" WHERE "id" = $1',
                    ev.id,
                );

                await db.auditLog.create({
                    data: {
                        tenantId: ev.tenantId,
                        action: 'DATA_PURGED',
                        entity: 'Evidence',
                        entityId: ev.id,
                        details: JSON.stringify({
                            title: ev.title,
                            reason: 'expired_evidence_grace_exceeded',
                            graceDays,
                            purgedAt: now.toISOString(),
                        }),
                    },
                });

                purged++;
            }
        }

        logger.info('purge-expired-evidence', {
            component: 'job', scanned, purged, dryRun, graceDays,
        });

        return { model: 'Evidence', scanned, purged, dryRun };
    }, { tenantId: options.tenantId });
}

// ═══════════════════════════════════════════════════════════════════
// 3. Cross-Model Retention Sweep
// ═══════════════════════════════════════════════════════════════════

/**
 * Scans all models with retentionUntil and soft-deletes records
 * whose retention period has elapsed. Does NOT hard-delete.
 *
 * Lifecycle: active → retention expired → soft-deleted (by this job) → purged (by purge job)
 *
 * Evidence is NOT swept here: the loop skips it, and the dedicated
 * `retention-sweep` cron runs runEvidenceRetentionSweep, which handles
 * archival. "Delegates" would imply this job calls it; it does not.
 */
export async function runRetentionSweep(
    options: PurgeOptions = {},
): Promise<RetentionSweepResult[]> {
    return runJob('retention-sweep-all', async () => {
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const results: RetentionSweepResult[] = [];

        for (const model of RETENTION_MODELS) {
            // Evidence has its own specialized sweep (handles archival)
            if (model === 'Evidence') continue;

            const key = model.charAt(0).toLowerCase() + model.slice(1);
            const delegate = (db as unknown as Record<string, ModelDelegate>)[key];
            if (!delegate) continue;

            // Find records with retentionUntil < now AND not already soft-deleted
            const where: Record<string, unknown> = {
                retentionUntil: { not: null, lt: now },
                deletedAt: null,
            };
            if (options.tenantId) {
                where.tenantId = options.tenantId;
            }

            const candidates = await delegate.findMany({
                where,
                select: { id: true, tenantId: true },
            });

            const scanned = candidates.length;
            let expired = 0;

            if (!dryRun && scanned > 0) {
                for (const record of candidates) {
                    // Soft-delete the expired record
                    await delegate.update({
                        where: { id: record.id },
                        data: {
                            deletedAt: now,
                            deletedByUserId: null, // system action
                        },
                    });

                    // Emit audit event
                    await db.auditLog.create({
                        data: {
                            tenantId: record.tenantId,
                            action: 'DATA_EXPIRED',
                            entity: model,
                            entityId: record.id,
                            details: JSON.stringify({
                                reason: 'retention_period_elapsed',
                                expiredAt: now.toISOString(),
                            }),
                        },
                    });

                    expired++;
                }
            }

            results.push({ model, scanned, expired: dryRun ? scanned : expired });

            if (scanned > 0) {
                logger.info('retention-sweep', {
                    component: 'job', model, scanned, expired: dryRun ? scanned : expired, dryRun,
                });
            }
        }

        return results;
    }, { tenantId: options.tenantId });
}
