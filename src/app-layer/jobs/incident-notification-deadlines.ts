/**
 * NIS2 Article 23 deadline clock — the regulatory teeth.
 *
 * Runs FREQUENTLY (hourly) because a 24-hour early-warning deadline
 * needs sub-day granularity. For every live notification deadline on a
 * reportable incident:
 *
 *   - PENDING → DUE      when `now` enters the deadline's lead window.
 *   - PENDING/DUE → OVERDUE   when `dueAt` passes without a SUBMITTED
 *     report. OVERDUE is the loud one — a regulatory deadline was
 *     missed; it escalates to a notification + a dashboard flag.
 *
 * SUBMITTED + NOT_REQUIRED rows are terminal and never touched.
 *
 * On each transition an in-app notification fires to the incident
 * owner + every tenant OWNER/ADMIN (deduped per (deadline, type, day)).
 *
 * Two scope modes mirror the other reminder jobs:
 *   - tenantId provided → scan that single tenant.
 *   - tenantId omitted  → scan every tenant (system-wide hourly cron).
 *
 * Batched to respect the N+1 query guardrail: one candidate fetch, two
 * `updateMany` status writes, one membership fetch, one notification
 * `createMany`.
 *
 * Methodology adapted (CC BY 4.0) from Kshreenath/NIS2-Checklist —
 * Paolo Carner / BARE Consulting. NOT legal advice.
 */
import type { PrismaClient, Prisma, IncidentNotificationKind } from '@prisma/client';
import { logger } from '@/lib/observability/logger';

const HOUR_MS = 60 * 60 * 1000;

/**
 * How long BEFORE a deadline the row flips PENDING→DUE. Per-kind so the
 * lead is proportional to the deadline horizon — a 1-month deadline
 * wants days of warning, a 24h deadline only hours.
 */
export const DEFAULT_LEAD_MS_BY_KIND: Record<IncidentNotificationKind, number> = {
    EARLY_WARNING_24H: 6 * HOUR_MS,
    DETAILED_72H: 18 * HOUR_MS,
    FINAL_1MONTH: 72 * HOUR_MS,
};

const CANDIDATE_CAP = 5000;

export interface IncidentDeadlineOptions {
    tenantId?: string;
    /** Override the "now" anchor — test-only seam. */
    now?: Date;
    /** Override the per-kind lead windows. */
    leadMsByKind?: Record<IncidentNotificationKind, number>;
}

export interface IncidentDeadlineResult {
    /** Live deadlines inspected. */
    scanned: number;
    /** PENDING → DUE transitions. */
    becameDue: number;
    /** → OVERDUE transitions. */
    becameOverdue: number;
    /** In-app notifications written (after dedupe). */
    notified: number;
    /** True if the candidate fetch hit the cap (more work remains). */
    capped: boolean;
}

function dayStamp(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/**
 * Pure transition decision for one deadline. Exported for unit tests.
 * Returns the target status, or null if no change.
 */
export function decideTransition(
    status: 'PENDING' | 'DUE',
    dueAt: Date,
    now: Date,
    leadMs: number,
): 'DUE' | 'OVERDUE' | null {
    if (now.getTime() >= dueAt.getTime()) {
        // status is only ever PENDING | DUE here (terminal rows are
        // excluded by the candidate query), so a passed deadline always
        // escalates to OVERDUE.
        return 'OVERDUE';
    }
    if (status === 'PENDING' && now.getTime() >= dueAt.getTime() - leadMs) {
        return 'DUE';
    }
    return null;
}

export async function processIncidentNotificationDeadlines(
    db: PrismaClient,
    options: IncidentDeadlineOptions = {},
): Promise<IncidentDeadlineResult> {
    const now = options.now ?? new Date();
    const leadByKind = options.leadMsByKind ?? DEFAULT_LEAD_MS_BY_KIND;
    const { tenantId } = options;
    const scope = tenantId ? 'tenant-scoped' : 'system-wide';

    logger.info('incident-deadline scan starting', {
        component: 'incident-notification-deadlines',
        scope,
    });

    // 1. Candidate fetch — live deadlines (PENDING/DUE) on reportable
    //    incidents. SUBMITTED/NOT_REQUIRED are terminal and excluded.
    const candidates = await db.incidentNotification.findMany({
        where: {
            status: { in: ['PENDING', 'DUE'] },
            ...(tenantId ? { tenantId } : {}),
            incident: { reportable: true },
        },
        select: {
            id: true,
            tenantId: true,
            incidentId: true,
            kind: true,
            dueAt: true,
            status: true,
            incident: {
                select: {
                    reference: true,
                    ownerUserId: true,
                    tenant: { select: { slug: true } },
                },
            },
        },
        take: CANDIDATE_CAP,
        orderBy: { dueAt: 'asc' },
    });

    const result: IncidentDeadlineResult = {
        scanned: candidates.length,
        becameDue: 0,
        becameOverdue: 0,
        notified: 0,
        capped: candidates.length >= CANDIDATE_CAP,
    };
    if (result.capped) {
        logger.warn('incident-deadline scan hit candidate cap — more remain', {
            component: 'incident-notification-deadlines',
            cap: CANDIDATE_CAP,
        });
    }

    // 2. Decide transitions in memory.
    const toDue: string[] = [];
    const toOverdue: string[] = [];
    type Transition = {
        notificationId: string;
        tenantId: string;
        incidentId: string;
        kind: IncidentNotificationKind;
        reference: string;
        ownerUserId: string | null;
        slug: string;
        target: 'DUE' | 'OVERDUE';
    };
    const transitions: Transition[] = [];

    for (const c of candidates) {
        const target = decideTransition(
            c.status as 'PENDING' | 'DUE',
            c.dueAt,
            now,
            leadByKind[c.kind],
        );
        if (!target) continue;
        if (target === 'DUE') toDue.push(c.id);
        else toOverdue.push(c.id);
        transitions.push({
            notificationId: c.id,
            tenantId: c.tenantId,
            incidentId: c.incidentId,
            kind: c.kind,
            reference: c.incident.reference,
            ownerUserId: c.incident.ownerUserId,
            slug: c.incident.tenant.slug,
            target,
        });
    }

    if (transitions.length === 0) {
        logger.info('incident-deadline scan — no transitions', {
            component: 'incident-notification-deadlines',
            scanned: result.scanned,
        });
        return result;
    }

    // 3. Status writes — two bounded updates, each CONDITIONAL on the status
    //    the row was read in (#5102). Between the read and the write a
    //    person can file the report (SUBMITTED) or mark the incident not
    //    reportable (NOT_REQUIRED); an unconditional write turned a filed
    //    Article 23 report into OVERDUE and told every admin the deadline
    //    was missed. Only rows the write actually moved are announced.
    const moved = new Set<string>();
    if (toDue.length > 0) {
        const rows = await db.incidentNotification.updateManyAndReturn({
            where: { id: { in: toDue }, status: 'PENDING' },
            data: { status: 'DUE' },
            select: { id: true },
        });
        for (const r of rows) moved.add(r.id);
        result.becameDue = rows.length;
    }
    if (toOverdue.length > 0) {
        const rows = await db.incidentNotification.updateManyAndReturn({
            where: { id: { in: toOverdue }, status: { in: ['PENDING', 'DUE'] } },
            data: { status: 'OVERDUE' },
            select: { id: true },
        });
        for (const r of rows) moved.add(r.id);
        result.becameOverdue = rows.length;
    }
    const announced = transitions.filter((t) => moved.has(t.notificationId));
    if (announced.length === 0) return result;

    // 4. Resolve recipients — one membership fetch for all tenants in
    //    play, then build the notification rows.
    const tenantIds = Array.from(new Set(announced.map((t) => t.tenantId)));
    const admins = await db.tenantMembership.findMany({
        where: {
            tenantId: { in: tenantIds },
            role: { in: ['OWNER', 'ADMIN'] },
            status: 'ACTIVE',
        },
        select: { tenantId: true, userId: true },
    });
    const adminsByTenant = new Map<string, string[]>();
    for (const m of admins) {
        const arr = adminsByTenant.get(m.tenantId) ?? [];
        arr.push(m.userId);
        adminsByTenant.set(m.tenantId, arr);
    }

    const stamp = dayStamp(now);
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const t of announced) {
        const recipients = new Set<string>(adminsByTenant.get(t.tenantId) ?? []);
        if (t.ownerUserId) recipients.add(t.ownerUserId);

        const type =
            t.target === 'OVERDUE'
                ? ('INCIDENT_DEADLINE_OVERDUE' as const)
                : ('INCIDENT_DEADLINE_DUE' as const);
        const kindLabel = KIND_LABELS[t.kind];
        const title =
            t.target === 'OVERDUE'
                ? `OVERDUE: ${kindLabel} for ${t.reference}`
                : `Deadline approaching: ${kindLabel} for ${t.reference}`;
        const message =
            t.target === 'OVERDUE'
                ? `The NIS2 Article 23 ${kindLabel.toLowerCase()} for incident ${t.reference} has passed without a filed report. File it now.`
                : `The NIS2 Article 23 ${kindLabel.toLowerCase()} for incident ${t.reference} is approaching. Prepare to file.`;
        const linkUrl = `/t/${t.slug}/incidents/${t.incidentId}`;

        for (const userId of recipients) {
            rows.push({
                tenantId: t.tenantId,
                userId,
                type,
                title,
                message,
                linkUrl,
                dedupeKey: `${t.tenantId}:${type}:${t.notificationId}:${userId}:${stamp}`,
            });
        }
    }

    if (rows.length > 0) {
        const written = await db.notification.createMany({
            data: rows,
            skipDuplicates: true,
        });
        result.notified = written.count;
    }

    logger.info('incident-deadline scan complete', {
        component: 'incident-notification-deadlines',
        scanned: result.scanned,
        becameDue: result.becameDue,
        becameOverdue: result.becameOverdue,
        notified: result.notified,
    });

    return result;
}

const KIND_LABELS: Record<IncidentNotificationKind, string> = {
    EARLY_WARNING_24H: '24-hour early warning',
    DETAILED_72H: '72-hour detailed report',
    FINAL_1MONTH: '1-month final report',
};
