/**
 * Calendar loaders — reminder-backed.
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
import type { WorkItemStatus } from '@prisma/client';
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

// ─── Deadline sources that already had reminder jobs but no calendar ──
//
// Each of these entities drives a reminder/escalation job, so the platform
// already treated its date as a deadline — the calendar just wasn't
// showing it. Same contract as every loader above: tenant-scoped, ordered
// ascending by the date column, capped, reporting its own truncation.

/**
 * Access-review recertification deadlines (`AccessReview.dueAt`). Backed
 * by `access-review-reminder` + `access-review-overdue-escalation`.
 * A CLOSED review is done; soft-deleted reviews are excluded.
 */
export async function loadAccessReviewEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.accessReview.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            dueAt: true,
            status: true,
            reviewerUserId: true,
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            return {
                id: `ACCESS_REVIEW:${r.id}:access-review-due`,
                type: 'access-review-due',
                category: 'audit',
                title: `Access review: ${r.name}`,
                entityName: r.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, r.status === 'CLOSED'),
                entityType: 'ACCESS_REVIEW',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/access-reviews/${r.id}`),
                ownerUserId: r.reviewerUserId,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Training assignment due dates (`TrainingAssignment.dueAt`). COMPLETED
 * assignments surface as `done` (the receipt), everything else carries the
 * live deadline.
 */
export async function loadTrainingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.trainingAssignment.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            dueAt: true,
            status: true,
            completedAt: true,
            course: { select: { name: true } },
            employee: { select: { fullName: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            const isDone = r.status === 'COMPLETED' || r.completedAt !== null;
            return {
                id: `TRAINING_ASSIGNMENT:${r.id}:training-due`,
                type: 'training-due',
                category: 'task',
                title: `Training due: ${r.course.name}`,
                entityName: r.course.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TRAINING_ASSIGNMENT',
                entityId: r.id,
                // Training lives under /admin/training — there is no top-level
                // /training route (this href used to 404).
                href: tenantHrefFromCtx(ctx, `/admin/training`),
                // Employee is an HR record, not a platform User (no userId
                // on the model), so there is no ownerUserId to route
                // notifications by — the assignee shows as detail copy.
                detail: r.employee.fullName,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Incident-notification SLA deadlines (`IncidentNotification.dueAt`) —
 * the NIS2 Art.23 early-warning / full-notification clock, already driven
 * by the `incident-notification-deadlines` job. SUBMITTED and
 * NOT_REQUIRED are terminal, so they render as `done`.
 *
 * `dueAt` is non-null on this model, so there is no null guard.
 */
export async function loadIncidentNotificationEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.incidentNotification.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            kind: true,
            dueAt: true,
            status: true,
            incidentId: true,
            // A notification row carries no user column at all. It inherits the
            // incident's commander — the person accountable for the incident
            // whose regulatory clock this is.
            incident: { select: { title: true, ownerUserId: true } },
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows.map((r): CalendarEvent => {
        const isDone = r.status === 'SUBMITTED' || r.status === 'NOT_REQUIRED';
        return {
            id: `INCIDENT_NOTIFICATION:${r.id}:incident-notification-due`,
            type: 'incident-notification-due',
            category: 'finding',
            title: `Incident notification (${r.kind}): ${r.incident.title}`,
            entityName: r.incident.title,
            date: r.dueAt.toISOString(),
            status: classifyStatus(r.dueAt, now, isDone),
            entityType: 'INCIDENT_NOTIFICATION',
            entityId: r.id,
            // Deep-link to the specific Art.23 notification obligation on the
            // incident overview (each notification carries a matching anchor id),
            // not the incident root — the calendar is advertising the
            // notification deadline, so the page should surface it.
            href: tenantHrefFromCtx(
                ctx,
                `/incidents/${r.incidentId}#incident-notification-${r.id}`,
            ),
            ownerUserId: r.incident.ownerUserId ?? undefined,
        };
    });
    return sourceResult(events, rows.length, limit);
}

/**
 * Control-exception expiry (`ControlException.expiresAt`) — when an
 * accepted exception lapses the control snaps back to non-compliant, so
 * the expiry is a real deadline. Backed by `exception-expiry-monitor`.
 * Only APPROVED exceptions have a live clock; REQUESTED/REJECTED aren't
 * in force and EXPIRED has already lapsed.
 */
export async function loadControlExceptionEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.controlException.findMany({
        where: {
            tenantId: ctx.tenantId,
            // Hand-written because ControlException is NOT in
            // SOFT_DELETE_MODELS despite having the column…
            deletedAt: null,
            // …and this one is needed because the extension would not have
            // reached it even if it were: relations are never filtered.
            // A deleted control's exceptions are not deleted with it.
            control: { deletedAt: null },
            status: 'APPROVED',
            expiresAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            expiresAt: true,
            controlId: true,
            // `riskAcceptedByUserId` (non-null) rather than `createdByUserId`
            // or the parent control's owner: it names whoever accepted the risk
            // this exception carries, and it is the PRIMARY recipient
            // `exception-expiry-monitor` already emails about this same date.
            // The calendar and the reminder now agree on whose deadline it is.
            riskAcceptedByUserId: true,
            control: { select: { name: true } },
        },
        orderBy: { expiresAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.expiresAt)
        .map((r): CalendarEvent => {
            const date = r.expiresAt as Date;
            return {
                id: `CONTROL_EXCEPTION:${r.id}:control-exception-expiry`,
                type: 'control-exception-expiry',
                category: 'control',
                title: `Exception expires: ${r.control.name}`,
                entityName: r.control.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'CONTROL_EXCEPTION',
                entityId: r.id,
                // Anchor to the exceptions panel on the control overview
                // (default tab) so an expiring exception lands on the exception,
                // not a control root that shows no sign of it.
                href: tenantHrefFromCtx(ctx, `/controls/${r.controlId}#control-exceptions`),
                ownerUserId: r.riskAcceptedByUserId,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Vendor reassessment dates (`VendorAssessment.nextReviewAt`) — distinct
 * from `Vendor.nextReviewAt` (the vendor-level review): this is the date
 * a specific completed assessment falls due for redoing. CLOSED
 * assessments are done.
 */
export async function loadVendorAssessmentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.vendorAssessment.findMany({
        where: {
            tenantId: ctx.tenantId,
            nextReviewAt: { not: null, gte: range.from, lte: range.to },
            // See `loadVendorDocumentEvents`: nested relations are outside the
            // soft-delete extension's reach, and this model has no `deletedAt`.
            vendor: { deletedAt: null },
        },
        select: {
            id: true,
            nextReviewAt: true,
            status: true,
            vendorId: true,
            // The assessment's own user columns are workflow receipts
            // (requestedBy / sentBy / reviewedBy / decidedBy / closedBy).
            // Accountability for redoing it sits with the vendor's owner.
            vendor: { select: { name: true, ownerUserId: true } },
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewAt)
        .map((r): CalendarEvent => {
            const date = r.nextReviewAt as Date;
            return {
                id: `VENDOR_ASSESSMENT:${r.id}:vendor-assessment-review`,
                type: 'vendor-assessment-review',
                category: 'vendor',
                title: `Vendor reassessment: ${r.vendor.name}`,
                entityName: r.vendor.name,
                date: date.toISOString(),
                status: classifyStatus(date, now, r.status === 'CLOSED'),
                entityType: 'VENDOR_ASSESSMENT',
                entityId: r.id,
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.vendorId}?tab=assessments`,
                ),
                ownerUserId: r.vendor.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

