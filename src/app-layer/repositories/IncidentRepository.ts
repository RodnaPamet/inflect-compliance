import { PrismaTx } from '@/lib/db-context';
import { RequestContext } from '../types';
import { Prisma } from '@prisma/client';

// List-page SELECT — deliberately omits the encrypted `description`
// (the detail page loads that). Notifications are pulled in a light
// shape so the list can surface the NEXT regulatory deadline + tone.
const incidentListSelect = {
    id: true,
    reference: true,
    title: true,
    severity: true,
    phase: true,
    incidentType: true,
    detectedAt: true,
    reportable: true,
    ownerUserId: true,
    createdAt: true,
    notifications: {
        select: { kind: true, dueAt: true, status: true },
    },
} as const;

/**
 * The register's KPI cards, counted over the tenant's WHOLE incident
 * population — never derived from a capped list read, so they stay right
 * when the list itself is truncated.
 */
export interface IncidentKpiCounts {
    total: number;
    /** Every incident not in the terminal CLOSED phase. */
    open: number;
    reportable: number;
    /** Incidents with at least one Article 23 notification DUE or OVERDUE. */
    deadlinesDueOrOverdue: number;
}

export class IncidentRepository {
    static async kpiCounts(db: PrismaTx, ctx: RequestContext): Promise<IncidentKpiCounts> {
        const where = { tenantId: ctx.tenantId };
        const [total, open, reportable, deadlinesDueOrOverdue] = await Promise.all([
            db.incident.count({ where }),
            db.incident.count({ where: { ...where, phase: { not: 'CLOSED' } } }),
            db.incident.count({ where: { ...where, reportable: true } }),
            db.incident.count({
                where: {
                    ...where,
                    notifications: { some: { status: { in: ['DUE', 'OVERDUE'] } } },
                },
            }),
        ]);
        return { total, open, reportable, deadlinesDueOrOverdue };
    }

    static async list(
        db: PrismaTx,
        ctx: RequestContext,
        options: { take?: number } = {},
    ) {
        return db.incident.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { detectedAt: 'desc' },
            select: incidentListSelect,
            take: options.take ?? 200,
        });
    }

    static async getById(db: PrismaTx, ctx: RequestContext, id: string) {
        return db.incident.findFirst({
            where: { id, tenantId: ctx.tenantId },
            include: {
                notifications: { orderBy: { dueAt: 'asc' } },
                timeline: { orderBy: { at: 'desc' }, take: 500 },
                evidenceLinks: {
                    include: {
                        evidence: {
                            select: { id: true, title: true, type: true, status: true },
                        },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });
    }

    /**
     * Next tenant-scoped reference for the current year — INC-YYYY-NNN.
     * Counts existing incidents whose reference shares the year prefix
     * and bumps the ordinal. Tenant-bound + reference-unique, so a race
     * surfaces as a P2002 the caller retries.
     */
    static async nextReference(db: PrismaTx, ctx: RequestContext, year: number) {
        const prefix = `INC-${year}-`;
        const count = await db.incident.count({
            where: { tenantId: ctx.tenantId, reference: { startsWith: prefix } },
        });
        const ordinal = String(count + 1).padStart(3, '0');
        return `${prefix}${ordinal}`;
    }

    static async create(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.IncidentUncheckedCreateInput, 'tenantId'>,
    ) {
        return db.incident.create({
            data: { ...data, tenantId: ctx.tenantId },
        });
    }

    static async update(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: Omit<Prisma.IncidentUncheckedUpdateInput, 'tenantId'>,
    ) {
        const existing = await db.incident.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!existing) return null;
        return db.incident.update({ where: { id }, data });
    }

    // ─── Article 23 notification deadlines ──────────────────────────

    static async createNotifications(
        db: PrismaTx,
        ctx: RequestContext,
        incidentId: string,
        rows: ReadonlyArray<{
            kind: Prisma.IncidentNotificationCreateManyInput['kind'];
            dueAt: Date;
        }>,
    ) {
        return db.incidentNotification.createMany({
            data: rows.map((r) => ({
                tenantId: ctx.tenantId,
                incidentId,
                kind: r.kind,
                dueAt: r.dueAt,
            })),
            skipDuplicates: true,
        });
    }

    static async listNotifications(db: PrismaTx, ctx: RequestContext, incidentId: string) {
        return db.incidentNotification.findMany({
            where: { tenantId: ctx.tenantId, incidentId },
            orderBy: { dueAt: 'asc' },
            // At most three kinds per incident (unique [incidentId, kind]).
            take: 10,
        });
    }

    static async getNotification(
        db: PrismaTx,
        ctx: RequestContext,
        incidentId: string,
        kind: Prisma.IncidentNotificationWhereInput['kind'],
    ) {
        return db.incidentNotification.findFirst({
            where: { tenantId: ctx.tenantId, incidentId, kind },
        });
    }

    static async updateNotification(
        db: PrismaTx,
        ctx: RequestContext,
        id: string,
        data: Omit<Prisma.IncidentNotificationUncheckedUpdateInput, 'tenantId' | 'incidentId'>,
    ) {
        return db.incidentNotification.update({ where: { id }, data });
    }

    // ─── Timeline ───────────────────────────────────────────────────

    static async addTimelineEntry(
        db: PrismaTx,
        ctx: RequestContext,
        data: Omit<Prisma.IncidentTimelineEntryUncheckedCreateInput, 'tenantId'>,
    ) {
        return db.incidentTimelineEntry.create({
            data: { ...data, tenantId: ctx.tenantId },
        });
    }

    static async listTimeline(db: PrismaTx, ctx: RequestContext, incidentId: string) {
        return db.incidentTimelineEntry.findMany({
            where: { tenantId: ctx.tenantId, incidentId },
            orderBy: { at: 'desc' },
            take: 500,
        });
    }

    // ─── Forensic evidence links ────────────────────────────────────

    /** Confirm an evidence record belongs to this tenant (FK safety). */
    static async evidenceExists(db: PrismaTx, ctx: RequestContext, evidenceId: string) {
        const e = await db.evidence.findFirst({
            where: { id: evidenceId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        return Boolean(e);
    }

    static async linkEvidence(
        db: PrismaTx,
        ctx: RequestContext,
        data: { incidentId: string; evidenceId: string; forensicCategory?: string | null },
    ) {
        return db.incidentEvidence.create({
            data: {
                tenantId: ctx.tenantId,
                incidentId: data.incidentId,
                evidenceId: data.evidenceId,
                forensicCategory: data.forensicCategory ?? null,
            },
        });
    }

    static async unlinkEvidence(
        db: PrismaTx,
        ctx: RequestContext,
        incidentId: string,
        evidenceId: string,
    ) {
        return db.incidentEvidence.deleteMany({
            where: { tenantId: ctx.tenantId, incidentId, evidenceId },
        });
    }
}
