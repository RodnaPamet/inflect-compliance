/**
 * Calendar loaders — risk-treatment.
 *
 * One `load*Events` per deadline source. Each is tenant-scoped, ordered
 * ascending by its date column, capped, and reports its own truncation.
 */
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability';
import { internal } from '@/lib/errors/types';
import { assertCanRead } from '../../policies/common';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../domain/work-item-status';
import {
    evidenceExpiryScopeWhere,
    EVIDENCE_REVIEWED_STATUS,
} from '../../domain/evidence-expiry';
import {
    CONTROL_TEST_ELIGIBILITY,
    isControlTestSatisfied,
} from '../../domain/control-test-due';
import { effectiveDueAt } from '../due-planning';
import { urgencyFromDaysUntil, DAY_MS } from '@/lib/urgency';
import { hasPermission, type PermissionKey } from '@/lib/security/permission-middleware';
import { env } from '@/env';
import type { TaskStatus } from '@prisma/client';
import type { RequestContext } from '../../types';
import {
    type CalendarEvent,
    type CalendarEventCategory,
    type CalendarEventStatus,
    type CalendarEventType,
    type CalendarResponse,
    type CalendarSourceName,
    CALENDAR_EVENT_CATEGORIES,
    CALENDAR_EVENT_STATUSES,
} from '../../schemas/calendar.schemas';

import {
    sourceResult,
    fetchNearest,
    classifyStatus,
    tenantHrefFromCtx,
    type CalendarSourceResult,
    type DateRange,
} from './shared';

// ─── Epic G-7 — treatment plan + milestone calendar loaders ─────────

/**
 * Each non-completed milestone contributes one calendar event keyed
 * by its `dueDate`. Completed milestones surface with status `done`
 * so the heatmap can show "this was on the calendar; here's the
 * receipt". Click-through lands on the parent risk's detail page,
 * scrolled to the treatment-plan card section.
 */
export async function loadTreatmentMilestoneEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.treatmentMilestone.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueDate: { gte: range.from, lte: range.to },
            // Skip milestones whose parent plan was soft-deleted, AND those
            // whose grandparent risk was. The plan predicate alone was a
            // half-filter: a milestone's click-through lands on
            // `/risks/{riskId}`, so a live plan under a deleted risk produced a
            // calendar entry pointing at a page the user cannot open.
            //
            // (Note this filters DELETION only, not the risk's status — a
            // milestone under a live plan still surfaces for an open risk in
            // any state, which is the original intent.)
            treatmentPlan: { deletedAt: null, risk: { deletedAt: null } },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            completedAt: true,
            sortOrder: true,
            treatmentPlan: {
                select: {
                    id: true,
                    riskId: true,
                    // A milestone has no owner column of its own (only
                    // `completedByUserId`, which is a receipt, not an
                    // assignment). It inherits the plan's owner — the person
                    // accountable for the treatment the milestone belongs to.
                    ownerUserId: true,
                    risk: { select: { title: true } },
                },
            },
        },
        orderBy: { dueDate: 'asc' },
        take: limit,
    });
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const riskId = r.treatmentPlan?.riskId;
        // A milestone whose plan lost its risk link would emit a bare
        // `/risks/` href — a list-page URL masquerading as a deep link.
        // Omit it rather than ship a misleading click target.
        if (!riskId) continue;
        const date = r.dueDate;
        const isDone = r.completedAt !== null;
        const riskTitle = r.treatmentPlan?.risk?.title ?? 'Risk';
        events.push({
            id: `TREATMENT_MILESTONE:${r.id}:treatment-milestone-due`,
            type: 'treatment-milestone-due',
            category: 'risk',
            title: `Milestone: ${r.title}`,
            entityName: r.title,
            date: date.toISOString(),
            status: classifyStatus(date, now, isDone),
            entityType: 'TREATMENT_MILESTONE',
            entityId: r.id,
            // Land on the risk's treatment-plan (assessment tab), not the
            // overview root — a milestone is a treatment-plan artefact.
            href: tenantHrefFromCtx(ctx, `/risks/${riskId}?tab=assessment`),
            detail: riskTitle,
            ownerUserId: r.treatmentPlan?.ownerUserId,
        });
    }
    return sourceResult(events, rows.length, limit);
}

/**
 * Treatment plans contribute one event per non-completed plan keyed
 * by `targetDate` so the calendar shows the plan-level deadline next
 * to its constituent milestone deadlines.
 */
export async function loadTreatmentPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.riskTreatmentPlan.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            // The plan outlives a soft-deleted risk; without this its target
            // date keeps surfacing under a risk nobody can open.
            risk: { deletedAt: null },
            status: { in: ['DRAFT', 'ACTIVE', 'OVERDUE'] },
            targetDate: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            riskId: true,
            strategy: true,
            targetDate: true,
            // NON-NULL on this model — every plan has an accountable owner.
            ownerUserId: true,
            risk: { select: { title: true } },
        },
        orderBy: { targetDate: 'asc' },
        take: limit,
    });
    const events = rows.map((r): CalendarEvent => {
        const date = r.targetDate;
        return {
            id: `RISK_TREATMENT_PLAN:${r.id}:treatment-plan-target`,
            type: 'treatment-plan-target',
            category: 'risk',
            title: `Plan target: ${r.risk?.title ?? 'Risk'}`,
            entityName: r.risk?.title ?? 'Risk',
            date: date.toISOString(),
            status: classifyStatus(date, now, false),
            entityType: 'RISK_TREATMENT_PLAN',
            entityId: r.id,
            // The plan target belongs on the assessment tab (treatment plan),
            // distinct from the risk-review destination.
            href: tenantHrefFromCtx(ctx, `/risks/${r.riskId}?tab=assessment`),
            detail: `${r.strategy} strategy`,
            ownerUserId: r.ownerUserId,
        };
    });
    return sourceResult(events, rows.length, limit);
}

