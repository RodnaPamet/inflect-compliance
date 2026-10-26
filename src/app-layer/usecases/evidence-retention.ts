/**
 * Evidence retention usecases:
 * - updateEvidenceRetention
 * - listExpiringEvidence
 * - listExpiredEvidence
 * - archiveEvidence
 * - unarchiveEvidence
 */
import { Prisma, RetentionPolicy } from '@prisma/client';
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite, assertCanAdmin } from '../policies/common';
import { logEvent } from '../events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, notFound } from '@/lib/errors/types';
import { runEvidenceRetentionSweep } from '../jobs/retention';

/**
 * Update retention settings on an evidence record.
 * ADMIN/EDITOR only.
 */
export async function updateEvidenceRetention(
    ctx: RequestContext,
    evidenceId: string,
    data: {
        retentionUntil?: string | null;
        retentionPolicy?: string;
        retentionDays?: number | null;
    },
) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
        });
        if (!evidence) throw notFound('Evidence not found');

        const updateData: Prisma.EvidenceUpdateInput = {};
        let nextRetentionUntil: Date | null | undefined;
        if (data.retentionUntil !== undefined) {
            nextRetentionUntil = data.retentionUntil ? new Date(data.retentionUntil) : null;
        }
        if (data.retentionPolicy !== undefined) {
            updateData.retentionPolicy = data.retentionPolicy as RetentionPolicy;
        }
        if (data.retentionDays !== undefined) {
            updateData.retentionDays = data.retentionDays;
        }

        // If the policy after this edit is DAYS_AFTER_UPLOAD and retentionDays
        // is set, compute retentionUntil. The policy the request names wins:
        // a row moved to FIXED_DATE or NONE keeps the date it was given, where
        // the stored policy alone would overwrite it with createdAt + days.
        if (
            (data.retentionPolicy ?? evidence.retentionPolicy) === 'DAYS_AFTER_UPLOAD' &&
            (data.retentionDays ?? evidence.retentionDays)
        ) {
            const days = data.retentionDays ?? evidence.retentionDays ?? 0;
            const base = evidence.createdAt;
            nextRetentionUntil = new Date(base.getTime() + days * 86_400_000);
        }
        if (nextRetentionUntil !== undefined) {
            updateData.retentionUntil = nextRetentionUntil;
        }

        // A new retention date that has not passed, or none at all, ends the
        // lapse. Left set, `expiredAt` keeps the row under Archived and keeps
        // the 365-day purge clock running for evidence somebody chose to keep.
        const clearsExpiry =
            !!evidence.expiredAt &&
            nextRetentionUntil !== undefined &&
            !retentionHasLapsed(nextRetentionUntil, new Date());
        if (clearsExpiry) {
            updateData.expiredAt = null;
        }

        const updated = await db.evidence.update({
            where: { id: evidenceId },
            data: updateData,
        });

        await logEvent(db, ctx, {
            action: 'EVIDENCE_RETENTION_UPDATED',
            entityType: 'Evidence',
            entityId: evidenceId,
            details: JSON.stringify({
                retentionUntil: updateData.retentionUntil,
                retentionPolicy: updateData.retentionPolicy,
                retentionDays: updateData.retentionDays,
            }),
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'retention_updated',
                model: 'Evidence',
                retentionUntil: updateData.retentionUntil ? String(updateData.retentionUntil) : null,
                retentionPolicy: updateData.retentionPolicy,
                retentionDays: updateData.retentionDays,
                clearedExpiredAt: clearsExpiry ? evidence.expiredAt?.toISOString() ?? null : null,
            },
        });

        // R5-P3 #7 — retention edits change the freshness/expiring KPIs; bump.
        await bumpEntityCacheVersion(ctx, 'evidence');
        return updated;
    });
}

/**
 * List evidence expiring within N days.
 */
export async function listExpiringEvidence(ctx: RequestContext, days: number = 30) {
    assertCanRead(ctx);
    const future = new Date(Date.now() + days * 86_400_000);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.evidence.findMany({
            where: {
                tenantId: ctx.tenantId,
                retentionUntil: { not: null, lte: future },
                isArchived: false,
                deletedAt: null,
            },
            orderBy: { retentionUntil: 'asc' },
            include: {
                // Evidence↔Control is a many-to-many join now; surface the
                // first linked control as `control` for the retention view.
                evidenceControlLinks: { select: { control: { select: { id: true, name: true, annexId: true } } } },
            },
        });
        return rows.map((ev) => ({ ...ev, control: ev.evidenceControlLinks[0]?.control ?? null }));
    });
}

/**
 * List already-expired evidence (isArchived=true by retention sweep).
 */
export async function listExpiredEvidence(ctx: RequestContext) {
    assertCanRead(ctx);

    return runInTenantContext(ctx, async (db) => {
        const rows = await db.evidence.findMany({
            where: {
                tenantId: ctx.tenantId,
                expiredAt: { not: null },
                deletedAt: null,
            },
            orderBy: { expiredAt: 'desc' },
            include: {
                // Evidence↔Control is a many-to-many join now; surface the
                // first linked control as `control` for the retention view.
                evidenceControlLinks: { select: { control: { select: { id: true, name: true, annexId: true } } } },
            },
        });
        return rows.map((ev) => ({ ...ev, control: ev.evidenceControlLinks[0]?.control ?? null }));
    });
}

/**
 * Archive evidence manually. ADMIN/EDITOR only.
 */
export async function archiveEvidence(ctx: RequestContext, evidenceId: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
        });
        if (!evidence) throw notFound('Evidence not found');
        if (evidence.isArchived) return evidence; // idempotent

        const updated = await db.evidence.update({
            where: { id: evidenceId },
            data: { isArchived: true },
        });

        await logEvent(db, ctx, {
            action: 'EVIDENCE_ARCHIVED',
            entityType: 'Evidence',
            entityId: evidenceId,
            details: JSON.stringify({ title: evidence.title, reason: 'manual' }),
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'archived',
                model: 'Evidence',
                reason: 'manual',
            },
        });

        // R5-P3 #7 — archived rows leave the default list; bump the cache.
        await bumpEntityCacheVersion(ctx, 'evidence');
        return updated;
    });
}

/**
 * The nightly sweep archives a row whose `retentionUntil` is before the run
 * (`lt: now`, `jobs/retention.ts`). A date equal to now counts as lapsed here
 * so that a row this module keeps active is never one the next run archives.
 */
function retentionHasLapsed(retentionUntil: Date | string | null, now: Date): boolean {
    if (retentionUntil === null) return false;
    return new Date(retentionUntil).getTime() <= now.getTime();
}

/**
 * Unarchive evidence, returning it to the active list. ADMIN/EDITOR only.
 *
 * Evidence the retention sweep archived carries `expiredAt` as well as the
 * flag, and the Archived view lists a row with either set, so both are
 * cleared. While the retention date has passed, unarchive is REFUSED
 * (`RETENTION_DATE_PASSED`, owner decision on #4277): the next nightly sweep
 * would archive the row again, and clearing the date here would erase a
 * retention policy as a side effect of a different action. A new or empty
 * date set in Edit evidence (`updateEvidenceRetention`) is the way back.
 * The audit row keeps the expiry stamp it cleared.
 */
export async function unarchiveEvidence(ctx: RequestContext, evidenceId: string) {
    assertCanWrite(ctx);

    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
        });
        if (!evidence) throw notFound('Evidence not found');
        if (!evidence.isArchived && !evidence.expiredAt) return evidence; // idempotent

        // #4277 — refuse while the retention date has passed, and say what to
        // do instead. Unarchiving such a row used to leave it under Archived
        // (its `expiredAt` stayed set) and the nightly sweep archived it again.
        if (retentionHasLapsed(evidence.retentionUntil, new Date())) {
            throw new ConflictError(
                "This evidence's retention date has passed. Set a new retention date first, then unarchive it.",
                { reason: 'RETENTION_DATE_PASSED' },
            );
        }

        const updated = await db.evidence.update({
            where: { id: evidenceId },
            // `expiredAt` goes too: with the retention date empty or ahead, an
            // expiry stamp left from an earlier date would keep the row in
            // the Archived view after it is unarchived.
            data: { isArchived: false, expiredAt: null },
        });

        await logEvent(db, ctx, {
            action: 'EVIDENCE_UNARCHIVED',
            entityType: 'Evidence',
            entityId: evidenceId,
            details: JSON.stringify({ title: evidence.title }),
            detailsJson: {
                category: 'data_lifecycle',
                operation: 'unarchived',
                model: 'Evidence',
                clearedExpiredAt: evidence.expiredAt?.toISOString() ?? null,
            },
        });

        // R5-P3 #7 — unarchived rows return to the default list; bump the cache.
        await bumpEntityCacheVersion(ctx, 'evidence');
        return updated;
    });
}

/**
 * Run retention sweep (ADMIN only or system job).
 */
export async function runRetentionSweepUsecase(
    ctx: RequestContext,
    options: { dryRun?: boolean } = {},
) {
    assertCanAdmin(ctx);
    return runEvidenceRetentionSweep({
        tenantId: ctx.tenantId,
        dryRun: options.dryRun,
    });
}

/**
 * Get retention metrics for the tenant.
 */
export async function getRetentionMetrics(ctx: RequestContext) {
    assertCanRead(ctx);
    const now = new Date();
    const in30Days = new Date(Date.now() + 30 * 86_400_000);

    return runInTenantContext(ctx, async (db) => {
        const expiringCount = await db.evidence.count({
            where: {
                tenantId: ctx.tenantId,
                retentionUntil: { not: null, lte: in30Days, gt: now },
                isArchived: false,
                deletedAt: null,
            },
        });

        const archivedCount = await db.evidence.count({
            where: {
                tenantId: ctx.tenantId,
                isArchived: true,
                deletedAt: null,
            },
        });

        const expiredCount = await db.evidence.count({
            where: {
                tenantId: ctx.tenantId,
                expiredAt: { not: null },
                isArchived: false,
                deletedAt: null,
            },
        });

        // Top controls with expiring evidence — read through the
        // Evidence↔Control join so an evidence linked to several controls
        // counts toward each of them (one join row per control).
        const expiringLinks = await db.evidenceControlLink.findMany({
            where: {
                tenantId: ctx.tenantId,
                evidence: {
                    retentionUntil: { not: null, lte: in30Days, gt: now },
                    isArchived: false,
                    deletedAt: null,
                },
            },
            select: { controlId: true, control: { select: { id: true, name: true, annexId: true } } },
        });

        const controlMap = new Map<string, { controlId: string; name: string; annexId: string; count: number }>();
        for (const link of expiringLinks) {
            const key = link.controlId;
            if (!controlMap.has(key)) {
                controlMap.set(key, {
                    controlId: key,
                    name: link.control?.name || 'Unknown',
                    annexId: link.control?.annexId || '',
                    count: 0,
                });
            }
            controlMap.get(key)!.count++;
        }

        const topControlsWithExpiringEvidence = [...controlMap.values()]
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            expiringCount,
            archivedCount,
            expiredCount,
            topControlsWithExpiringEvidence,
        };
    });
}

/**
 * Assert that evidence is not archived. Use before linking evidence.
 * Throws badRequest if archived.
 */
export async function assertNotArchived(ctx: RequestContext, evidenceId: string) {
    return runInTenantContext(ctx, async (db) => {
        const evidence = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
        });
        if (!evidence) throw notFound('Evidence not found');
        if (evidence.isArchived) {
            const { badRequest } = await import('@/lib/errors/types');
            throw badRequest('Cannot link archived evidence. Unarchive first or use active evidence.');
        }
        return evidence;
    });
}
