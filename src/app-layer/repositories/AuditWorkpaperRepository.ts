/**
 * Audit workpapers (#3675) — repository.
 *
 * Every query filters by `tenantId` (defence in depth on top of RLS), and runs
 * on the tenant-bound client the usecase hands it. The table is one-way: this
 * file has an insert, a read, and one conditional UPDATE — the review stamp,
 * NULL to a value — and no other write. The trigger `audit_workpaper_one_way`
 * refuses any other UPDATE, and `app_user` holds no DELETE.
 *
 * `AuditWorkpaperFinding` is written by `linkFindings` alone, insert-only.
 * Nothing here writes a `Finding`.
 */
import type { Prisma } from '@prisma/client';

import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';

/** The columns a list shows: the facts, never the per-unit arrays. */
const summarySelect = {
    id: true,
    procedureId: true,
    catalogueVersion: true,
    periodLabel: true,
    populationCount: true,
    sampleSize: true,
    exceptionCount: true,
    conclusion: true,
    conclusionBasis: true,
    auditorAgentId: true,
    controlTestRunId: true,
    reviewedAt: true,
    reviewedByUserId: true,
    createdAt: true,
} satisfies Prisma.AuditWorkpaperSelect;

export interface AuditWorkpaperListFilters {
    procedureId?: string;
    periodLabel?: string;
    auditorAgentId?: string;
}

export class AuditWorkpaperRepository {
    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.AuditWorkpaperUncheckedCreateInput, 'tenantId' | 'reviewedAt' | 'reviewedByUserId'>,
    ) {
        return db.auditWorkpaper.create({
            data: { ...data, tenantId: ctx.tenantId },
            select: { id: true, createdAt: true },
        });
    }

    /**
     * The workpaper whose sample is BINDING for this procedure and period: the
     * first one, by insertion, that drew a sample. The trigger's own query is
     * the same predicate and order.
     */
    static async findBindingSample(
        db: PrismaTx,
        ctx: RequestContext,
        procedureId: string,
        periodLabel: string,
    ) {
        return db.auditWorkpaper.findFirst({
            where: { tenantId: ctx.tenantId, procedureId, periodLabel, sampleEpoch: { not: null } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
                id: true,
                sampleEpoch: true,
                seedFingerprint: true,
                sampleSize: true,
                sampledUnitIds: true,
                populationCount: true,
                populationDigest: true,
            },
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.auditWorkpaper.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                findingLinks: {
                    select: { findingId: true, createdAt: true },
                    orderBy: { createdAt: 'asc' },
                    take: 5000,
                },
            },
        });
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        filters: AuditWorkpaperListFilters,
        take: number,
    ) {
        return db.auditWorkpaper.findMany({
            where: {
                tenantId: ctx.tenantId,
                ...(filters.procedureId ? { procedureId: filters.procedureId } : {}),
                ...(filters.periodLabel ? { periodLabel: filters.periodLabel } : {}),
                ...(filters.auditorAgentId ? { auditorAgentId: filters.auditorAgentId } : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { ...summarySelect, _count: { select: { findingLinks: true } } },
            take,
        });
    }

    /**
     * THE ONE-WAY STAMP. Conditional on the row being unstamped, so two
     * concurrent reviewers cannot both succeed: the second matches zero rows.
     */
    static async stampReview(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        reviewedByUserId: string,
        reviewedAt: Date,
    ): Promise<number> {
        const res = await db.auditWorkpaper.updateMany({
            where: { id, tenantId: ctx.tenantId, reviewedAt: null },
            data: { reviewedAt, reviewedByUserId },
        });
        return res.count;
    }

    /** Insert links, skipping any the workpaper already has. Never writes the finding. */
    static async linkFindings(
        db: PrismaTx,
        ctx: RequestContext,
        workpaperId: string,
        findingIds: readonly string[],
    ): Promise<number> {
        if (findingIds.length === 0) return 0;
        const res = await db.auditWorkpaperFinding.createMany({
            data: findingIds.map((findingId) => ({ tenantId: ctx.tenantId, workpaperId, findingId })),
            skipDuplicates: true,
        });
        return res.count;
    }
}
