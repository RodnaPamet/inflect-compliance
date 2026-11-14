/**
 * Deadline Monitor — Periodic Detection of Due/Overdue Items
 *
 * Scans across multiple entity types to detect upcoming and overdue
 * deadlines. Returns normalized `DueItem[]` for downstream processing
 * (notification dispatch, dashboard aggregation, alerting).
 *
 * Monitored entities:
 *   - Control       → nextDueAt
 *   - Policy        → nextReviewAt
 *   - Task          → dueAt
 *   - Risk          → nextReviewAt, targetDate
 *   - ControlTestPlan → nextDueAt
 *
 * Design principles:
 *   - Detection — no email sending; the one write is Phase 0's flip of
 *     past-due treatment plans to OVERDUE (plus its audit rows)
 *   - Tenant-isolated — all queries filter by tenantId
 *   - Idempotent — same input produces same output; safe to re-run
 *   - Deterministic — output is sorted and stable
 *   - Configurable windows — default [30, 7, 1] days
 *
 * @module app-layer/jobs/deadline-monitor
 */
import { prisma } from '@/lib/prisma';
import { DEFAULT_REMINDER_WINDOWS } from '@/lib/urgency';
import { Prisma } from '@prisma/client';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';
import type { DueItem, DueItemUrgency, JobRunResult } from './types';
import { TERMINAL_TASK_STATUSES } from '../domain/task-status';
import { openRiskStatusFilter } from '../domain/risk-status';
import { CONTROL_TEST_ELIGIBILITY } from '../domain/control-test-due';
import { appendAuditEntry } from '@/lib/audit';

// ─── Configuration ──────────────────────────────────────────────────

export interface DeadlineMonitorOptions {
    tenantId?: string;
    /** Detection windows in days, sorted descending. Default: [30, 7, 1] */
    windows?: number[];
    /** Override current time (for testing) */
    now?: Date;
}

export interface DeadlineMonitorResult {
    items: DueItem[];
    counts: {
        overdue: number;
        urgent: number;
        upcoming: number;
    };
    byEntity: Record<string, number>;
    /** Sources whose scan hit its cap, so some deadlines were not read (#5202). */
    cappedSources: string[];
}

// ─── Urgency Classifier ─────────────────────────────────────────────

/**
 * Classify a due date relative to now.
 * Returns null if the date is beyond the largest window.
 */
export function classifyUrgency(
    dueDate: Date,
    now: Date,
    windows: number[] = [...DEFAULT_REMINDER_WINDOWS],
): { urgency: DueItemUrgency; daysRemaining: number } | null {
    const diffMs = dueDate.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / 86_400_000);

    if (daysRemaining < 0) {
        return { urgency: 'OVERDUE', daysRemaining };
    }

    const maxWindow = Math.max(...windows);
    if (daysRemaining > maxWindow) {
        return null; // Not yet in any detection window
    }

    // Find the tightest matching window
    const urgentThreshold = windows.find(w => w <= 7) ?? 7;

    if (daysRemaining <= urgentThreshold) {
        return { urgency: 'URGENT', daysRemaining };
    }

    return { urgency: 'UPCOMING', daysRemaining };
}

// ─── Entity Scanners ────────────────────────────────────────────────

type DueRange = { gte: Date; lte: Date } | { lt: Date };

/**
 * Read one source's due rows in TWO bounded passes either side of `now`
 * (#5202): the rows coming due (`now..horizon`, soonest first) and the rows
 * already overdue (most recently overdue first).
 *
 * A single `ORDER BY due ASC LIMIT n` across the fleet put the OLDEST
 * overdue rows first, and rows that are overdue for good never leave that
 * set — so one tenant's abandoned backlog filled the cap and every other
 * tenant's approaching and newly overdue deadlines fell past it, with nothing
 * recording the cut. Splitting the read keeps upcoming deadlines out of the
 * overdue backlog's reach, and ordering the overdue pass newest-first makes
 * the oldest abandoned rows the ones a cap drops. A source that still hits
 * its cap is recorded in `capped` and logged.
 */
async function scanBothSides<T>(
    source: string,
    cap: number,
    now: Date,
    horizon: Date,
    capped: string[],
    fetch: (range: DueRange, order: 'asc' | 'desc', take: number) => Promise<T[]>,
): Promise<T[]> {
    const [upcoming, overdue] = await Promise.all([
        fetch({ gte: now, lte: horizon }, 'asc', cap + 1),
        fetch({ lt: now }, 'desc', cap + 1),
    ]);
    if (upcoming.length > cap || overdue.length > cap) {
        capped.push(source);
        logger.warn('deadline-monitor: scan hit cap — later deadlines dropped this run', {
            component: 'job',
            jobName: 'deadline-monitor',
            source,
            cap,
            upcomingCapped: upcoming.length > cap,
            overdueCapped: overdue.length > cap,
        });
    }
    return [...overdue.slice(0, cap), ...upcoming.slice(0, cap)];
}

/**
 * Scan controls with nextDueAt approaching or overdue.
 */
async function scanControls(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);

    const where: Prisma.ControlWhereInput = {
        // Shared with the calendar's `loadControlEvents`. The two surfaces
        // report on the same rows and used to judge them differently — the
        // calendar called an IMPLEMENTED control's lapsed test `done` while
        // this scan emailed it as overdue. See `domain/control-test-due.ts`.
        ...CONTROL_TEST_ELIGIBILITY,
        nextDueAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;
    else where.tenantId = { not: null };

    const controls = await scanBothSides(
        'CONTROL',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.control.findMany({
                where: { ...where, nextDueAt: range },
                select: {
                    id: true,
                    tenantId: true,
                    name: true,
                    nextDueAt: true,
                    ownerUserId: true,
                },
                orderBy: { nextDueAt: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const c of controls) {
        if (!c.tenantId || !c.nextDueAt) continue;
        const classification = classifyUrgency(c.nextDueAt, now, windows);
        if (!classification) continue;

        items.push({
            entityType: 'CONTROL',
            entityId: c.id,
            tenantId: c.tenantId,
            name: c.name,
            reason: classification.urgency === 'OVERDUE'
                ? `Control testing overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Control testing due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: c.nextDueAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: c.ownerUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan policies with nextReviewAt approaching or overdue.
 */
async function scanPolicies(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);

    const where: Prisma.PolicyWhereInput = {
        deletedAt: null,
        status: { notIn: ['ARCHIVED'] },
        nextReviewAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const policies = await scanBothSides(
        'POLICY',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.policy.findMany({
                where: { ...where, nextReviewAt: range },
                select: {
                    id: true,
                    tenantId: true,
                    title: true,
                    nextReviewAt: true,
                    ownerUserId: true,
                },
                orderBy: { nextReviewAt: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const p of policies) {
        if (!p.nextReviewAt) continue;
        const classification = classifyUrgency(p.nextReviewAt, now, windows);
        if (!classification) continue;

        items.push({
            entityType: 'POLICY',
            entityId: p.id,
            tenantId: p.tenantId,
            name: p.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Policy review overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Policy review due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: p.nextReviewAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: p.ownerUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan tasks with dueAt approaching or overdue.
 * Only open/in-progress tasks — not completed or cancelled.
 */
async function scanTasks(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);

    const where: Prisma.TaskWhereInput = {
        deletedAt: null,
        status: { notIn: [...TERMINAL_TASK_STATUSES] },
        dueAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const tasks = await scanBothSides(
        'TASK',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.task.findMany({
                where: { ...where, dueAt: range },
                select: {
                    id: true,
                    tenantId: true,
                    title: true,
                    dueAt: true,
                    assigneeUserId: true,
                },
                orderBy: { dueAt: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const t of tasks) {
        if (!t.dueAt) continue;
        const classification = classifyUrgency(t.dueAt, now, windows);
        if (!classification) continue;

        items.push({
            entityType: 'TASK',
            entityId: t.id,
            tenantId: t.tenantId,
            name: t.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Task overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Task due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: t.dueAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: t.assigneeUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan risks with nextReviewAt approaching or overdue.
 */
async function scanRisks(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);

    const where: Prisma.RiskWhereInput = {
        deletedAt: null,
        status: openRiskStatusFilter(),
        nextReviewAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const risks = await scanBothSides(
        'RISK',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.risk.findMany({
                where: { ...where, nextReviewAt: range },
                select: {
                    id: true,
                    tenantId: true,
                    title: true,
                    nextReviewAt: true,
                    ownerUserId: true,
                },
                orderBy: { nextReviewAt: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const r of risks) {
        if (!r.nextReviewAt) continue;
        const classification = classifyUrgency(r.nextReviewAt, now, windows);
        if (!classification) continue;

        items.push({
            entityType: 'RISK',
            entityId: r.id,
            tenantId: r.tenantId,
            name: r.title,
            reason: classification.urgency === 'OVERDUE'
                ? `Risk review overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Risk review due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: r.nextReviewAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: r.ownerUserId ?? undefined,
        });
    }
    return items;
}

/**
 * Scan test plans with nextDueAt approaching or overdue.
 */
async function scanTestPlans(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);

    const where: Prisma.ControlTestPlanWhereInput = {
        status: 'ACTIVE',
        nextDueAt: { not: null, lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const plans = await scanBothSides(
        'TEST_PLAN',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.controlTestPlan.findMany({
                where: { ...where, nextDueAt: range },
                select: {
                    id: true,
                    tenantId: true,
                    name: true,
                    nextDueAt: true,
                    ownerUserId: true,
                    controlId: true,
                },
                orderBy: { nextDueAt: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const p of plans) {
        if (!p.nextDueAt) continue;
        const classification = classifyUrgency(p.nextDueAt, now, windows);
        if (!classification) continue;

        items.push({
            entityType: 'TEST_PLAN',
            entityId: p.id,
            tenantId: p.tenantId,
            name: p.name,
            reason: classification.urgency === 'OVERDUE'
                ? `Test plan overdue by ${Math.abs(classification.daysRemaining)} day(s)`
                : `Test plan due in ${classification.daysRemaining} day(s)`,
            urgency: classification.urgency,
            dueDate: p.nextDueAt.toISOString(),
            daysRemaining: classification.daysRemaining,
            ownerUserId: p.ownerUserId ?? undefined,
        });
    }
    return items;
}

// ─── Epic G-7 — treatment-plan + milestone scanners ────────────────

/**
 * Scan treatment plans whose `targetDate` is approaching or past
 * AND whose status is not already COMPLETED. The monitor doesn't
 * mutate state — it emits DueItem records that downstream
 * notification + dashboard surfaces consume.
 */
async function scanTreatmentPlans(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);
    const where: Prisma.RiskTreatmentPlanWhereInput = {
        deletedAt: null,
        status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
        targetDate: { lte: horizon },
    };
    if (tenantId) where.tenantId = tenantId;

    const plans = await scanBothSides(
        'TREATMENT_PLAN',
        1000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.riskTreatmentPlan.findMany({
                where: { ...where, targetDate: range },
                select: {
                    id: true,
                    tenantId: true,
                    riskId: true,
                    ownerUserId: true,
                    targetDate: true,
                    risk: { select: { title: true } },
                },
                orderBy: { targetDate: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const p of plans) {
        if (!p.targetDate) continue;
        const c = classifyUrgency(p.targetDate, now, windows);
        if (!c) continue;
        items.push({
            entityType: 'TREATMENT_PLAN',
            entityId: p.id,
            tenantId: p.tenantId,
            name: p.risk?.title ?? '(unnamed risk)',
            reason:
                c.urgency === 'OVERDUE'
                    ? `Treatment plan target overdue by ${Math.abs(c.daysRemaining)} day(s)`
                    : `Treatment plan target due in ${c.daysRemaining} day(s)`,
            urgency: c.urgency,
            dueDate: p.targetDate.toISOString(),
            daysRemaining: c.daysRemaining,
            ownerUserId: p.ownerUserId,
        });
    }
    return items;
}

/**
 * Scan treatment milestones whose `dueDate` is approaching or past
 * AND whose `completedAt` is null. Each milestone surfaces as its
 * own DueItem so per-owner digests can group them naturally.
 */
async function scanTreatmentMilestones(
    now: Date,
    windows: number[],
    tenantId: string | undefined,
    capped: string[],
): Promise<DueItem[]> {
    const horizon = new Date(now.getTime() + Math.max(...windows) * 86_400_000);
    const where: Prisma.TreatmentMilestoneWhereInput = {
        completedAt: null,
        dueDate: { lte: horizon },
        treatmentPlan: { deletedAt: null, status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] } },
    };
    if (tenantId) where.tenantId = tenantId;

    const milestones = await scanBothSides(
        'TREATMENT_MILESTONE',
        2000,
        now,
        horizon,
        capped,
        (range, order, take) =>
            prisma.treatmentMilestone.findMany({
                where: { ...where, dueDate: range },
                select: {
                    id: true,
                    tenantId: true,
                    title: true,
                    dueDate: true,
                    treatmentPlan: {
                        select: { id: true, ownerUserId: true, riskId: true },
                    },
                },
                orderBy: { dueDate: order },
                take,
            }),
    );

    const items: DueItem[] = [];
    for (const m of milestones) {
        if (!m.dueDate) continue;
        const c = classifyUrgency(m.dueDate, now, windows);
        if (!c) continue;
        items.push({
            entityType: 'TREATMENT_MILESTONE',
            entityId: m.id,
            tenantId: m.tenantId,
            name: m.title,
            reason:
                c.urgency === 'OVERDUE'
                    ? `Milestone overdue by ${Math.abs(c.daysRemaining)} day(s)`
                    : `Milestone due in ${c.daysRemaining} day(s)`,
            urgency: c.urgency,
            dueDate: m.dueDate.toISOString(),
            daysRemaining: c.daysRemaining,
            ownerUserId: m.treatmentPlan?.ownerUserId,
        });
    }
    return items;
}

/**
 * Phase 0 — flip past-due treatment plans (DRAFT/ACTIVE) to OVERDUE
 * with one audit row per transition. Runs BEFORE the scanners so
 * the post-flip status is what downstream surfaces see. Each
 * transition is per-row + atomic so a concurrent renewal never
 * gets clobbered.
 */
async function transitionPlansToOverdue(
    now: Date,
    tenantId?: string,
): Promise<number> {
    const where: Prisma.RiskTreatmentPlanWhereInput = {
        deletedAt: null,
        status: { in: ['DRAFT', 'ACTIVE'] },
        targetDate: { lt: now },
    };
    if (tenantId) where.tenantId = tenantId;

    const candidates = await prisma.riskTreatmentPlan.findMany({
        where,
        // ownerUserId is included for parity with the scanner SELECTs —
        // the due-item-ownership ratchet asserts every SELECT in this
        // file carries an owner field. The transition itself doesn't
        // use it, but pulling it in costs nothing and keeps the shape
        // uniform for future "notify the owner of an overdue plan"
        // callers that build off this list.
        select: {
            id: true,
            tenantId: true,
            riskId: true,
            ownerUserId: true,
            targetDate: true,
        },
    });

    let transitioned = 0;
    for (const c of candidates) {
        const update = await prisma.riskTreatmentPlan.updateMany({
            where: {
                id: c.id,
                tenantId: c.tenantId,
                status: { in: ['DRAFT', 'ACTIVE'] },
                deletedAt: null,
                targetDate: { lt: now },
            },
            data: { status: 'OVERDUE' },
        });
        if (update.count === 0) continue;

        await appendAuditEntry({
            tenantId: c.tenantId,
            userId: null,
            actorType: 'SYSTEM',
            entity: 'RiskTreatmentPlan',
            entityId: c.id,
            action: 'TREATMENT_PLAN_MARKED_OVERDUE',
            detailsJson: {
                category: 'status_change',
                entityName: 'RiskTreatmentPlan',
                toStatus: 'OVERDUE',
                summary: `Treatment plan ${c.id} transitioned to OVERDUE at scheduled deadline`,
                after: {
                    riskId: c.riskId,
                    targetDateIso: c.targetDate?.toISOString() ?? null,
                    transitionedBy: 'deadline-monitor',
                },
            },
        });
        transitioned++;
    }

    return transitioned;
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Run the deadline monitor — scans all entity types and returns
 * a normalized list of due/overdue items.
 *
 * Detection, with ONE write. It does NOT send emails or create tasks.
 * It DOES, in Phase 0 (`transitionPlansToOverdue`), move past-due risk
 * treatment plans (DRAFT/ACTIVE) to OVERDUE, writing one
 * TREATMENT_PLAN_MARKED_OVERDUE audit row per transition, so the scan
 * that follows sees the post-flip status. Nothing else is modified.
 *
 * The output is suitable for downstream notification dispatch.
 */
export async function runDeadlineMonitor(
    options: DeadlineMonitorOptions = {},
): Promise<{ result: JobRunResult; items: DueItem[] }> {
    const jobRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startMs = performance.now();

    return runJob('deadline-monitor', async () => {
        const now = options.now ?? new Date();
        // The caller's windows decide BOTH the scan horizon and the urgency
        // classification (#5307). Classifying with the defaults while scanning
        // with the caller's windows made one digest call a 5-day item URGENT
        // here and UPCOMING in the calendar-deadlines monitor beside it.
        const windows = options.windows ?? [...DEFAULT_REMINDER_WINDOWS];

        // Phase 0 — flip past-due treatment plans before scanning so
        // the urgency classifier sees the post-flip status. Each
        // transition emits one TREATMENT_PLAN_MARKED_OVERDUE audit row.
        await transitionPlansToOverdue(now, options.tenantId);

        // Sources whose scan hit its cap this run (#5202). Never silent: a
        // capped source is logged and returned with the result.
        const capped: string[] = [];

        // Run all scanners in parallel
        const [
            controls,
            policies,
            tasks,
            risks,
            testPlans,
            treatmentPlans,
            treatmentMilestones,
        ] = await Promise.all([
            scanControls(now, windows, options.tenantId, capped),
            scanPolicies(now, windows, options.tenantId, capped),
            scanTasks(now, windows, options.tenantId, capped),
            scanRisks(now, windows, options.tenantId, capped),
            scanTestPlans(now, windows, options.tenantId, capped),
            scanTreatmentPlans(now, windows, options.tenantId, capped),
            scanTreatmentMilestones(now, windows, options.tenantId, capped),
        ]);

        const items = [
            ...controls,
            ...policies,
            ...tasks,
            ...risks,
            ...testPlans,
            ...treatmentPlans,
            ...treatmentMilestones,
        ];

        // Sort by urgency (OVERDUE first, then by days remaining)
        items.sort((a, b) => {
            const urgencyOrder = { OVERDUE: 0, URGENT: 1, UPCOMING: 2 };
            const ua = urgencyOrder[a.urgency];
            const ub = urgencyOrder[b.urgency];
            if (ua !== ub) return ua - ub;
            return a.daysRemaining - b.daysRemaining;
        });

        const counts = {
            overdue: items.filter(i => i.urgency === 'OVERDUE').length,
            urgent: items.filter(i => i.urgency === 'URGENT').length,
            upcoming: items.filter(i => i.urgency === 'UPCOMING').length,
        };

        const byEntity: Record<string, number> = {};
        for (const item of items) {
            byEntity[item.entityType] = (byEntity[item.entityType] ?? 0) + 1;
        }

        logger.info('deadline monitor completed', {
            component: 'job',
            jobName: 'deadline-monitor',
            total: items.length,
            ...counts,
            byEntity,
            cappedSources: capped,
        });

        const durationMs = Math.round(performance.now() - startMs);

        const result: JobRunResult = {
            jobName: 'deadline-monitor',
            jobRunId,
            success: true,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            itemsScanned: items.length,
            itemsActioned: counts.overdue + counts.urgent,
            itemsSkipped: counts.upcoming,
            details: { counts, byEntity, cappedSources: capped },
        };

        return { result, items };
    }, { tenantId: options.tenantId });
}
