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
import { purgeEvidenceBlobs } from '../services/evidence-blob-purge';

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
 * Soft-delete models that also carry GLOBAL (tenantId IS NULL) rows.
 *
 * Explicit rather than derived at runtime so adding a nullable-tenant model to
 * SOFT_DELETE_MODELS is a decision someone makes, not a default they inherit.
 * `Control` is the only such model today (`tenantId String?` in
 * prisma/schema/controls.prisma) — the shared framework library every tenant
 * reads.
 *
 * Carried over from `lib/retention-purge.ts`, a second, unreferenced
 * implementation of this sweep that held this guard while the LIVE path did
 * not. That file has been deleted; the guard was the only thing in it worth
 * keeping.
 */
const NULLABLE_TENANT_MODELS = new Set<string>(['Control']);

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

/**
 * How long the identity write artefacts are kept (#2843 finding 27).
 *
 * 730 days, matching `risk-snapshot-jobs.ts` — one retention answer for
 * compliance artefacts rather than two — and chosen between two real
 * pressures:
 *
 *   KEEP IT LONG ENOUGH. `IdentityWriteJournal` is the evidence that a
 *     directory write happened, and the write ladder's own refusal text says
 *     the seven-day dwell exists so an operator can compare a pass against
 *     what HR and IT actually did. An auditor sampling a 12-month period in
 *     early 2026 needs early-2025 rows present, so two cycles is the floor.
 *
 *   DO NOT KEEP IT FOREVER. The journal stores `externalUserId` and
 *     `priorStateJson` — directory identifiers for real people. Unbounded
 *     retention is a data-minimisation exposure, not only a growth one, and
 *     "forever" was the answer before this.
 */
export const DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS = 730;

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
            } else if (NULLABLE_TENANT_MODELS.has(model)) {
                // The scheduled sweep runs with NO tenant filter. Models whose
                // `tenantId` is nullable also hold GLOBAL rows — the shared
                // library every tenant reads — so an unfiltered purge would
                // hard-delete those platform-wide on one tenant's retention
                // clock.
                //
                // Unreachable today because `deleteControl` refuses to
                // soft-delete a global (usecases/control/mutations.ts:428), so
                // nothing ever sets `deletedAt` on one. But that is a guard in
                // a different file with nothing connecting the two, and this
                // sweep hard-deletes by raw SQL. It should be safe on its own
                // terms.
                whereClause.tenantId = { not: null };
            }

            const candidates = await delegate.findMany(withDeleted({
                where: whereClause,
                select: { id: true, tenantId: true },
            }));

            const scanned = candidates.length;
            let purged = 0;

            if (!dryRun) {
                // Evidence is the only model in this loop whose rows point at
                // an object in storage, so it is the only one with bytes to
                // reclaim. Done once for the whole batch rather than per row so
                // the sibling check sees the entire purge set — otherwise two
                // deduped rows purged in the same pass would each retain the
                // blob "for the other one" and neither would ever free it.
                if (model === 'Evidence') {
                    const blobs = await purgeEvidenceBlobs(
                        db,
                        candidates.map((c) => c.id),
                    );
                    if (blobs.failed > 0) {
                        logger.error('data-lifecycle: evidence blobs survived the sweep', {
                            component: 'data-lifecycle',
                            model,
                            ...blobs,
                        });
                    }
                }

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
            // Reclaim the stored bytes BEFORE the rows go. This is the
            // documented 365-day hard purge, and it deleted rows only — so the
            // DATA_PURGED entries below attested destructions that had not
            // happened. Batched across all candidates so the sibling check
            // (SHA-256 dedup: several Evidence rows can share one FileRecord)
            // sees the whole purge set and does not retain a blob for a
            // sibling that is also being purged in this same pass.
            const blobs = await purgeEvidenceBlobs(db, candidates.map((c) => c.id));
            if (blobs.failed > 0) {
                logger.error('data-lifecycle: evidence blobs survived the purge', {
                    component: 'data-lifecycle',
                    ...blobs,
                });
            }

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
                            blobPurge: blobs,
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

// ══════════════════════════════════════════════════════════════════════════
// 3. Purge identity write artefacts past their retention window
// ══════════════════════════════════════════════════════════════════════════

/**
 * Delete `IdentityWriteJournal` and `IntegrationExecution` rows older than the
 * retention window (#2843 finding 27).
 *
 * ── WHY AGE AND NOT `retentionUntil` ──
 *
 * `RETENTION_MODELS` above is the per-row mechanism: a model joins it only
 * when `retentionUntil` is on its update schema and its edit UI, and the
 * docblock there records what happens when that price is not paid — six
 * models sat in the list as guaranteed-empty queries run daily, forever,
 * behind a policy doc claiming the dates were enforced. Neither artefact here
 * has such a column and neither should: nobody sets a retention date on an
 * individual directory write.
 *
 * ── WHY THE AUDIT ROW CARRIES COUNTS AND NOT IDS ──
 *
 * The sibling evidence purge writes one `DATA_PURGED` row per record, naming
 * it. Doing that here would defeat the purge: the identifier being destroyed
 * is `externalUserId`, and copying it into an audit row that outlives the
 * journal retains exactly the personal data this exists to remove. So the
 * attestation is per-MODEL and per-run — what was destroyed, how much, and
 * the cutoff it was measured against.
 */
export async function purgeIdentityArtefactsOlderThan(
    options: PurgeOptions & { retentionDays?: number } = {},
): Promise<PurgeResult[]> {
    return runJob('purge-identity-artefacts', async () => {
        const now = options.now ?? new Date();
        const retentionDays = options.retentionDays ?? DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS;
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;
        const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

        // Grouped BY TENANT rather than purged in one sweep, because
        // `AuditLog.tenantId` is required — an attestation belongs to a
        // tenant, and a global run that wrote one row could not say whose
        // data it destroyed. The grouping is the attestation, not an
        // optimisation.
        const scope = options.tenantId ? { tenantId: options.tenantId } : {};
        const results: PurgeResult[] = [];

        // `attemptedAt` — when the write was TRIED — not `settledAt`, which is
        // null on a row that never settled. Pruning on a nullable column would
        // keep the unsettled rows forever, and those are the ones an operator
        // most wants bounded.
        const journalByTenant = await db.identityWriteJournal.groupBy({
            by: ['tenantId'],
            where: { ...scope, attemptedAt: { lt: cutoff } },
            _count: { _all: true },
        });
        const execByTenant = await db.integrationExecution.groupBy({
            by: ['tenantId'],
            where: { ...scope, executedAt: { lt: cutoff } },
            _count: { _all: true },
        });

        const journalTotal = journalByTenant.reduce((n, g) => n + g._count._all, 0);
        const execTotal = execByTenant.reduce((n, g) => n + g._count._all, 0);

        if (!dryRun) {
            for (const g of journalByTenant) {
                await db.identityWriteJournal.deleteMany({
                    where: { tenantId: g.tenantId, attemptedAt: { lt: cutoff } },
                });
                await writePurgeAttestation(
                    db, g.tenantId, 'IdentityWriteJournal', g._count._all, retentionDays, cutoff,
                );
            }
            for (const g of execByTenant) {
                await db.integrationExecution.deleteMany({
                    where: { tenantId: g.tenantId, executedAt: { lt: cutoff } },
                });
                await writePurgeAttestation(
                    db, g.tenantId, 'IntegrationExecution', g._count._all, retentionDays, cutoff,
                );
            }
        }

        results.push({
            model: 'IdentityWriteJournal',
            scanned: journalTotal,
            purged: dryRun ? 0 : journalTotal,
            dryRun,
        });
        results.push({
            model: 'IntegrationExecution',
            scanned: execTotal,
            purged: dryRun ? 0 : execTotal,
            dryRun,
        });

        logger.info('identity artefact retention purge', {
            component: 'job',
            dryRun,
            retentionDays,
            cutoff: cutoff.toISOString(),
            tenants: new Set([
                ...journalByTenant.map((g) => g.tenantId),
                ...execByTenant.map((g) => g.tenantId),
            ]).size,
            journal: journalTotal,
            executions: execTotal,
        });

        return results;
    });
}

/**
 * One `DATA_PURGED` row per tenant per model — COUNTS, never ids.
 *
 * The sibling evidence purge names each record it destroys. Doing that here
 * would defeat the purge: the identifier being removed is `externalUserId`,
 * and copying it into an audit row that outlives the journal retains exactly
 * the personal data this exists to remove.
 */
/**
 * Legacy access snapshots, and the identified people inside them (#3317).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DESTROYS, AND WHY IT HAS TO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LegacyAccount` holds email, display name, given and family names, username,
 * employee number, department, title and manager reference for identified
 * people in a customer's legacy application. `LegacyAccessSnapshot` is
 * deliberately IMMUTABLE — a changed account is a new row in a new snapshot,
 * never an update — which is what makes `payloadHash` recomputable months
 * later, and is also what made the history grow without bound. A connection
 * pulled daily kept everybody's access forever.
 *
 * Owner decision on #3317: a TTL sweep, 90-day default, tenant-settable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CLOCK IS THE CONSUMING RUN, NOT `pulledAt`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A snapshot pulled in March and first reconciled in September has a dispute
 * window that OPENS in September. Keying off `pulledAt` would delete it the
 * week it became relevant — which is why the consumed predicate is written
 * against the resolutions rather than against the snapshot's own dates.
 *
 * "Consumed" means `LegacyAccountResolution` rows exist for it, and that is the
 * only consumption signal there is: the schema has exactly two relations into
 * `LegacyAccessSnapshot` — `accounts` and `resolutions` — and only four modules
 * in `src/` touch the delegate at all.
 *
 * MAX(resolution.createdAt) is expressed as "no resolution newer than the
 * cutoff" rather than computed in memory. Same predicate, one query, and it
 * cannot be wrong about a snapshot with thousands of resolutions.
 *
 * It is the LAST consuming run, not the first. A snapshot reconciled twice has
 * its window reopened by the second run, because the suggestions a reviewer
 * might dispute are that run's.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN UNCONSUMED SNAPSHOT STILL AGES OUT, ON A SHORTER CLOCK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Otherwise a connection that pulls and never reconciles — a mapping left
 * half-configured, a campaign never launched — accumulates named people
 * indefinitely, which is the exact case #3317 was filed about. It gets a
 * shorter bound because NOTHING CITES IT: no recertification artefact points at
 * a snapshot with no resolutions, so deleting it costs a re-pull rather than
 * evidence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A COUPLING WORTH KNOWING ABOUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LegacyAccountResolution` CASCADEs from `IntegrationExecution`, which
 * `purgeIdentityArtefactsOlderThan` deletes after
 * DEFAULT_IDENTITY_ARTEFACT_RETENTION_DAYS (730). So the consumption signal is
 * itself perishable: if that window were ever shortened below the legacy
 * snapshot window, a CONSUMED snapshot would silently reclassify as unconsumed
 * and be destroyed on the SHORTER clock, inside its own dispute window.
 *
 * 730 against 90 leaves eight times the headroom today. The invariant is
 * asserted in `tests/integration/legacy-snapshot-retention.test.ts` rather than
 * left as a comment, because the failure is silent and the two numbers live in
 * different files.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It does not purge the accounts while keeping the snapshot row. That was the
 * third option in #3317 and it is the worst: `verifySnapshotPayloadHash` would
 * report every stripped snapshot as unverifiable, preserving the APPEARANCE of
 * integrity evidence while destroying the thing that could verify it. The
 * accounts go when the snapshot goes, by CASCADE, or neither goes.
 *
 * It is also not the DSAR path. Erasure already reaches these tables when a
 * subject asks; this is the DORMANT case erasure never hears about.
 */
export const DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS = 90;

/**
 * The unconsumed bound. 30 is a CHOSEN default, not one the #3317 decision
 * supplied — it says only "probably shorter". A tenant setting, so revising it
 * is configuration rather than a release.
 */
export const DEFAULT_LEGACY_SNAPSHOT_UNCONSUMED_RETENTION_DAYS = 30;

export interface PurgeLegacySnapshotOptions extends PurgeOptions {
    /** Overrides the tenant setting. Used by the scheduled job's dry run. */
    retentionDays?: number;
    unconsumedRetentionDays?: number;
}

export async function purgeLegacyAccessSnapshotsOlderThan(
    options: PurgeLegacySnapshotOptions = {},
): Promise<PurgeResult[]> {
    return runJob('purge-legacy-access-snapshots', async () => {
        const now = options.now ?? new Date();
        const dryRun = options.dryRun ?? false;
        const db = options.db ?? defaultPrisma;

        // PER TENANT, for two independent reasons, and the first is not an
        // optimisation: the windows are TENANT SETTINGS, so there is no single
        // cutoff to sweep with. The second is the one the identity-artefact
        // purge records — `AuditLog.tenantId` is required, so a global run that
        // wrote one attestation could not say whose data it destroyed.
        const tenantIds = options.tenantId
            ? [options.tenantId]
            : (
                await db.legacyAccessSnapshot.groupBy({
                    by: ['tenantId'],
                    _count: { _all: true },
                })
            ).map((g) => g.tenantId);

        // ── TWO HOISTED READS, NOT TWO PER TENANT ──
        //
        // `query-shape-guardrails` Layer D1 refused the obvious shape (settings
        // read and snapshot scan inside the tenant loop) and was right to: a
        // daily job over every tenant with legacy snapshots would issue 2N
        // queries. The same guard forced the same correction on
        // `legacy-adjudication.ts`, which is a sign it is the right shape here
        // rather than a hoop.
        //
        // The windows differ per tenant, so the scan cannot use one cutoff pair.
        // It uses one OR arm PER TENANT instead, each carrying that tenant's own
        // cutoffs — one round trip whatever the tenant count.
        const settingsRows = await db.tenantSecuritySettings.findMany({
            where: { tenantId: { in: tenantIds } },
            select: {
                tenantId: true,
                legacySnapshotRetentionDays: true,
                legacySnapshotUnconsumedRetentionDays: true,
            },
        });
        const settingsByTenant = new Map(settingsRows.map((r) => [r.tenantId, r]));

        // An explicit option wins, then the tenant setting, then the default. A
        // tenant with NO settings row has never opened the security page; it must
        // still be swept, or "no settings" becomes an opt-out of retention nobody
        // chose.
        const windowFor = (tenantId: string): { consumed: Date; unconsumed: Date } => {
            const row = settingsByTenant.get(tenantId);
            const retentionDays = options.retentionDays
                ?? row?.legacySnapshotRetentionDays
                ?? DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS;
            const unconsumedRetentionDays = options.unconsumedRetentionDays
                ?? row?.legacySnapshotUnconsumedRetentionDays
                ?? DEFAULT_LEGACY_SNAPSHOT_UNCONSUMED_RETENTION_DAYS;
            return {
                consumed: new Date(now.getTime() - retentionDays * 86_400_000),
                unconsumed: new Date(now.getTime() - unconsumedRetentionDays * 86_400_000),
            };
        };

        // The two arms per tenant are DISJOINT by construction (`some` against
        // `none`), so no snapshot can be selected twice and the counts add.
        const tenantArms: Prisma.LegacyAccessSnapshotWhereInput[] = tenantIds.map((tenantId) => {
            const w = windowFor(tenantId);
            return {
                tenantId,
                OR: [
                    {
                        // Consumed, and no consuming run is newer than the cutoff
                        // — i.e. MAX(resolution.createdAt) < cutoff, expressed as
                        // a relation filter so it is one query rather than a scan
                        // of every resolution.
                        resolutions: { some: {} },
                        NOT: { resolutions: { some: { createdAt: { gte: w.consumed } } } },
                    },
                    {
                        // Never consumed, on its own shorter clock.
                        resolutions: { none: {} },
                        pulledAt: { lt: w.unconsumed },
                    },
                ],
            };
        });

        // The ACCOUNT count is the number this issue is about, and it has to be
        // read BEFORE the delete because the accounts go by CASCADE — afterwards
        // there is nothing left to count, and an attestation naming only
        // snapshots would understate what was destroyed by three or four orders
        // of magnitude.
        const doomed = tenantArms.length === 0
            ? []
            : await db.legacyAccessSnapshot.findMany({
                where: { OR: tenantArms },
                select: { id: true, tenantId: true, _count: { select: { accounts: true } } },
            });

        const byTenant = new Map<string, { ids: string[]; accounts: number }>();
        for (const row of doomed) {
            const entry = byTenant.get(row.tenantId) ?? { ids: [], accounts: 0 };
            entry.ids.push(row.id);
            entry.accounts += row._count.accounts;
            byTenant.set(row.tenantId, entry);
        }

        const snapshotsTotal = doomed.length;
        const accountsTotal = doomed.reduce((n, s) => n + s._count.accounts, 0);

        if (!dryRun) {
            // WRITES per tenant, and that grouping is the attestation rather than
            // an optimisation: `AuditLog.tenantId` is required, so a single global
            // delete could not record whose data it destroyed.
            for (const [tenantId, entry] of byTenant) {
                const w = windowFor(tenantId);
                await db.legacyAccessSnapshot.deleteMany({
                    where: { tenantId, id: { in: entry.ids } },
                });
                await writePurgeAttestation(
                    db, tenantId, 'LegacyAccessSnapshot', entry.ids.length,
                    options.retentionDays
                        ?? settingsByTenant.get(tenantId)?.legacySnapshotRetentionDays
                        ?? DEFAULT_LEGACY_SNAPSHOT_RETENTION_DAYS,
                    w.consumed,
                );
                // A SECOND attestation, for the accounts. They are a different
                // model with a different retention argument, and the audit row for
                // a PII destruction should not have to be inferred from a
                // parent's.
                await writePurgeAttestation(
                    db, tenantId, 'LegacyAccount', entry.accounts,
                    options.unconsumedRetentionDays
                        ?? settingsByTenant.get(tenantId)?.legacySnapshotUnconsumedRetentionDays
                        ?? DEFAULT_LEGACY_SNAPSHOT_UNCONSUMED_RETENTION_DAYS,
                    w.unconsumed,
                );
            }
        }

        logger.info('legacy access snapshot retention purge', {
            component: 'job',
            dryRun,
            tenants: tenantIds.length,
            snapshots: snapshotsTotal,
            accounts: accountsTotal,
        });

        return [
            {
                model: 'LegacyAccessSnapshot',
                scanned: snapshotsTotal,
                purged: dryRun ? 0 : snapshotsTotal,
                dryRun,
            },
            {
                model: 'LegacyAccount',
                scanned: accountsTotal,
                purged: dryRun ? 0 : accountsTotal,
                dryRun,
            },
        ];
    });
}

async function writePurgeAttestation(
    db: typeof defaultPrisma,
    tenantId: string,
    model: string,
    purged: number,
    retentionDays: number,
    cutoff: Date,
): Promise<void> {
    await db.auditLog.create({
        data: {
            tenantId,
            action: 'DATA_PURGED',
            entity: model,
            entityId: `retention:${cutoff.toISOString()}`,
            details: JSON.stringify({ purged, retentionDays, cutoff: cutoff.toISOString() }),
        },
    });
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
