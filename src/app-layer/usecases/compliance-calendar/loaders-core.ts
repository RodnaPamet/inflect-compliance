/**
 * Calendar loaders — core.
 *
 * One `load*Events` per deadline source. Each is tenant-scoped, ordered
 * ascending by its date column, capped, and reports its own truncation.
 */
import { runInTenantContext, runInTenantReadContext } from '@/lib/db-context';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability';
import { internal } from '@/lib/errors/types';
import { assertCanRead } from '../../policies/common';
import { TERMINAL_TASK_STATUSES } from '../../domain/task-status';
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

// ─── Per-source loaders ──────────────────────────────────────────────

export async function loadEvidenceEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.evidence.findMany({
        where: {
            // Shared expiry scope — soft-deleted + archived evidence is
            // gone, so a review deadline for it is a phantom. This is the
            // same predicate the dashboard's evidence KPI uses.
            ...evidenceExpiryScopeWhere(ctx.tenantId),
            nextReviewDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewDate: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewDate: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewDate)
        .map((r): CalendarEvent => {
            const date = r.nextReviewDate as Date;
            const isDone = r.status === EVIDENCE_REVIEWED_STATUS && date > now;
            return {
                id: `EVIDENCE:${r.id}:evidence-review`,
                type: 'evidence-review',
                category: 'evidence',
                title: `Evidence review: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'EVIDENCE',
                entityId: r.id,
                // Evidence has no `/evidence/[id]` route — detail opens as a
                // sheet keyed off `?ev=`. This is the canonical deep-link
                // (EvidenceClient / EvidenceSubTable use the same).
                href: tenantHrefFromCtx(ctx, `/evidence?ev=${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

export async function loadPolicyEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.policy.findMany({
        where: {
            tenantId: ctx.tenantId,
            nextReviewAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            nextReviewAt: true,
            status: true,
            ownerUserId: true,
        },
        orderBy: { nextReviewAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextReviewAt)
        .map((r): CalendarEvent => {
            const date = r.nextReviewAt as Date;
            const isDone = r.status === 'ARCHIVED';
            return {
                id: `POLICY:${r.id}:policy-review`,
                type: 'policy-review',
                category: 'policy',
                title: `Policy review: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'POLICY',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/policies/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

export async function loadVendorEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const select = {
        id: true,
        name: true,
        nextReviewAt: true,
        contractRenewalAt: true,
        status: true,
        ownerUserId: true,
    } as const;
    // Two date columns → fetch each column's nearest-`limit` and union, so a
    // vendor whose only in-range date is the renewal isn't truncated behind
    // vendors with a review date (see `fetchNearest`).
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.vendor.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        nextReviewAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextReviewAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.vendor.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        contractRenewalAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { contractRenewalAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isOffboarded = r.status === 'OFFBOARDED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-review`,
                type: 'vendor-review',
                category: 'vendor',
                title: `Vendor review: ${r.name}`,
                entityName: r.name,
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isOffboarded),
                entityType: 'VENDOR',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/vendors/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
        if (
            r.contractRenewalAt &&
            r.contractRenewalAt >= range.from &&
            r.contractRenewalAt <= range.to
        ) {
            events.push({
                id: `VENDOR:${r.id}:vendor-renewal`,
                type: 'vendor-renewal',
                category: 'vendor',
                title: `Contract renewal: ${r.name}`,
                entityName: r.name,
                date: r.contractRenewalAt.toISOString(),
                status: classifyStatus(
                    r.contractRenewalAt,
                    now,
                    isOffboarded,
                ),
                entityType: 'VENDOR',
                entityId: r.id,
                // Land on the contract/renewal field so this is a distinct
                // destination from the vendor-review event (which lands on the
                // overview root). The field carries `id="vendor-contract-renewal"`.
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.id}?tab=overview#vendor-contract-renewal`,
                ),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
    }
    return { events, capped };
}

export async function loadVendorDocumentEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.vendorDocument.findMany({
        where: {
            tenantId: ctx.tenantId,
            validTo: { not: null, gte: range.from, lte: range.to },
            // The soft-delete extension injects `deletedAt: null` into the
            // TOP-LEVEL where only — it never descends into a relation. This
            // model has no `deletedAt` of its own (correctly: it is not
            // independently deletable), and its parent's soft delete is an
            // UPDATE, so the schema's `onDelete: Cascade` never fires either.
            // Without this predicate a deleted vendor's document expiries stay
            // on the calendar, attributed to a vendor that no longer exists.
            vendor: { deletedAt: null },
        },
        select: {
            id: true,
            type: true,
            validTo: true,
            vendorId: true,
            // A document row's only user column is `uploadedByUserId`, which
            // records who filed it, not who is accountable for renewing it.
            // Inherit the vendor's owner — the same person `vendor-review` and
            // `vendor-renewal` already route to.
            vendor: { select: { name: true, ownerUserId: true } },
        },
        orderBy: { validTo: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.validTo)
        .map((r): CalendarEvent => {
            const date = r.validTo as Date;
            return {
                id: `VENDOR_DOCUMENT:${r.id}:vendor-document-expiry`,
                type: 'vendor-document-expiry',
                category: 'vendor',
                title: `${r.type} expires: ${r.vendor.name}`,
                entityName: r.vendor.name,
                detail: r.type,
                date: date.toISOString(),
                status: classifyStatus(date, now, false),
                entityType: 'VENDOR_DOCUMENT',
                entityId: r.id,
                // Land on the Documents tab, not the vendor root — the
                // expiring document is what the user came for.
                href: tenantHrefFromCtx(
                    ctx,
                    `/vendors/${r.vendorId}?tab=documents`,
                ),
                ownerUserId: r.vendor.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

export async function loadAuditCycleEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    // AuditCycle is the only duration source today: emits an event with
    // `start` (periodStartAt) and `end` (periodEndAt). Either bound
    // intersecting the queried range surfaces the cycle.
    const select = {
        id: true,
        name: true,
        frameworkKey: true,
        periodStartAt: true,
        periodEndAt: true,
        status: true,
        // A cycle has no owner column; `createdByUserId` (non-null) is the
        // audit lead who scheduled it, and is what `calendar-deadlines.ts`
        // already routes cycle reminders to.
        createdByUserId: true,
    } as const;
    // Cycles are ranges intersecting the window three ways: starting in it,
    // ending in it, or straddling it entirely. Query each and union so a
    // cap keeps the nearest of each kind — a single `orderBy [start, end]`
    // would drop end-in-range/straddling cycles (NULL/earlier start sorts
    // them last) even when they are the soonest to matter.
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        periodStartAt: { gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { periodStartAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        periodEndAt: { gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { periodEndAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.auditCycle.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        deletedAt: null,
                        // Already running: began before the window and ends after it.
                        periodStartAt: { lte: range.from },
                        periodEndAt: { gte: range.to },
                    },
                    select,
                    orderBy: { periodStartAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events = rows
        .filter((r) => r.periodStartAt || r.periodEndAt)
        .map((r): CalendarEvent => {
            const start = r.periodStartAt ?? r.periodEndAt!;
            const end =
                r.periodEndAt && r.periodStartAt && r.periodEndAt !== r.periodStartAt
                    ? r.periodEndAt
                    : undefined;
            const isDone = r.status === 'COMPLETE';
            return {
                id: `AUDIT_CYCLE:${r.id}:audit-cycle`,
                type: 'audit-cycle',
                category: 'audit',
                title: `Audit cycle: ${r.name}`,
                entityName: r.name,
                date: start.toISOString(),
                end: end?.toISOString(),
                status: classifyStatus(end ?? start, now, isDone),
                entityType: 'AUDIT_CYCLE',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/audits/cycles/${r.id}`),
                detail: r.frameworkKey,
                ownerUserId: r.createdByUserId,
            };
        });
    return { events, capped };
}

export async function loadControlEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.control.findMany({
        where: {
            tenantId: ctx.tenantId,
            // Shared with `deadline-monitor.ts::scanControls` so the two
            // surfaces cannot drift on WHICH rows carry a test deadline,
            // having already drifted on how they judge them.
            ...CONTROL_TEST_ELIGIBILITY,
            nextDueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            name: true,
            nextDueAt: true,
            // `status` is deliberately NOT selected: it used to drive `isDone`
            // here, which is the defect `control-test-due.ts` exists to state.
            ownerUserId: true,
        },
        orderBy: { nextDueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.nextDueAt)
        .map((r): CalendarEvent => {
            const date = r.nextDueAt as Date;
            return {
                id: `CONTROL:${r.id}:control-review`,
                type: 'control-review',
                category: 'control',
                title: `Control review: ${r.name}`,
                entityName: r.name,
                date: date.toISOString(),
                // `nextDueAt` is the next TEST due date, and no ControlStatus
                // satisfies it — an IMPLEMENTED control is precisely the one
                // that must be tested on cadence. This used to pass
                // `status === 'IMPLEMENTED'`, which short-circuited
                // `classifyStatus` before any date comparison and rendered a
                // lapsed test as `done` while deadline-monitor emailed the very
                // same row as overdue.
                status: classifyStatus(date, now, isControlTestSatisfied()),
                entityType: 'CONTROL',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/controls/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

export async function loadTestPlanEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    // A test plan carries TWO due clocks — `nextDueAt` (frequency-derived)
    // and `nextRunAt` (cron-derived). The scheduling-model-unify note
    // mandates `effectiveDueAt = min(nextDueAt, nextRunAt)` on every due
    // surface: the live MANUAL path advances only `nextRunAt`, so reading
    // `nextDueAt` alone renders cron-scheduled plans permanently overdue.
    // Fetch each clock's nearest-`limit` (see `fetchNearest`), then emit at
    // the effective (earliest) date if that date falls in the window.
    // One shared `select` for both sub-queries — forking it would let the two
    // clocks emit different fields for the same plan.
    const select = {
        id: true,
        name: true,
        nextDueAt: true,
        nextRunAt: true,
        controlId: true,
        ownerUserId: true,
        control: { select: { name: true } },
    } as const;
    // Shared for the same reason as `select` above — the two clocks must agree
    // on which plans exist, not just on which fields they carry. The plan's own
    // `deletedAt` is auto-injected (ControlTestPlan is in SOFT_DELETE_MODELS);
    // the parent's is not, because the extension never descends into relations.
    // Deleting a control does not touch its plans, so without this a deleted
    // control's test deadlines keep appearing.
    const baseWhere = {
        tenantId: ctx.tenantId,
        status: 'ACTIVE',
        control: { deletedAt: null },
    } as const;
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.controlTestPlan.findMany({
                    where: {
                        ...baseWhere,
                        nextDueAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextDueAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.controlTestPlan.findMany({
                    where: {
                        ...baseWhere,
                        nextRunAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextRunAt: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const date = effectiveDueAt(r);
        // The effective clock may be a column NOT in the window (e.g. a past
        // `nextDueAt` earlier than an in-range `nextRunAt`) — that plan is
        // overdue before the window, not due inside it, so skip it.
        if (!date || date < range.from || date > range.to) continue;
        events.push({
            id: `CONTROL_TEST_PLAN:${r.id}:control-test-due`,
            type: 'control-test-due',
            category: 'control',
            title: `Test due: ${r.name}`,
            entityName: r.name,
            date: date.toISOString(),
            status: classifyStatus(date, now, false),
            entityType: 'CONTROL_TEST_PLAN',
            entityId: r.id,
            href: tenantHrefFromCtx(ctx, `/controls/${r.controlId}/tests/${r.id}`),
            detail: r.control.name,
            ownerUserId: r.ownerUserId ?? undefined,
        });
    }
    return { events, capped };
}

export async function loadTaskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.task.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueAt: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueAt: true,
            status: true,
            assigneeUserId: true,
        },
        orderBy: { dueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueAt)
        .map((r): CalendarEvent => {
            const date = r.dueAt as Date;
            // The imported constant, not a third copy of the same three
            // strings. This file already imports it and uses it correctly 240
            // lines below; a hand-written twin drifts silently — add a
            // terminal status to the enum and this list keeps calling those
            // tasks open, on the surface that reports what is due.
            const isDone = (TERMINAL_TASK_STATUSES as readonly string[]).includes(
                r.status,
            );
            return {
                id: `TASK:${r.id}:task-due`,
                type: 'task-due',
                category: 'task',
                title: `Task due: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'TASK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/tasks/${r.id}`),
                ownerUserId: r.assigneeUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

export async function loadRiskEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const select = {
        id: true,
        title: true,
        nextReviewAt: true,
        targetDate: true,
        status: true,
        ownerUserId: true,
    } as const;
    // Two date columns — fetch each column's nearest-`limit` and union so a
    // risk whose only in-range date is the mitigation target isn't truncated
    // behind risks with a review date (see `fetchNearest`).
    const { rows, capped } = await fetchNearest(
        [
            () =>
                db.risk.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        nextReviewAt: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { nextReviewAt: 'asc' },
                    take: limit,
                }),
            () =>
                db.risk.findMany({
                    where: {
                        tenantId: ctx.tenantId,
                        targetDate: { not: null, gte: range.from, lte: range.to },
                    },
                    select,
                    orderBy: { targetDate: 'asc' },
                    take: limit,
                }),
        ],
        limit,
    );
    const events: CalendarEvent[] = [];
    for (const r of rows) {
        const isClosed = r.status === 'CLOSED' || r.status === 'ACCEPTED';
        if (
            r.nextReviewAt &&
            r.nextReviewAt >= range.from &&
            r.nextReviewAt <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-review`,
                type: 'risk-review',
                category: 'risk',
                title: `Risk review: ${r.title}`,
                entityName: r.title,
                date: r.nextReviewAt.toISOString(),
                status: classifyStatus(r.nextReviewAt, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
        if (
            r.targetDate &&
            r.targetDate >= range.from &&
            r.targetDate <= range.to
        ) {
            events.push({
                id: `RISK:${r.id}:risk-target`,
                type: 'risk-target',
                category: 'risk',
                title: `Risk mitigation target: ${r.title}`,
                entityName: r.title,
                date: r.targetDate.toISOString(),
                status: classifyStatus(r.targetDate, now, isClosed),
                entityType: 'RISK',
                entityId: r.id,
                // The mitigation target lives on the assessment tab (where the
                // treatment strategy + target date are shown), NOT the overview
                // where risk-review lands — deep-link so the four risk event
                // types don't all collapse to the same destination.
                href: tenantHrefFromCtx(ctx, `/risks/${r.id}?tab=assessment`),
                ownerUserId: r.ownerUserId ?? undefined,
            });
        }
    }
    return { events, capped };
}

export async function loadFindingEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.finding.findMany({
        where: {
            tenantId: ctx.tenantId,
            dueDate: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            dueDate: true,
            status: true,
            // `assigneeUserId`, NOT the legacy free-text `owner`. See the emit
            // below — this selected `owner` and published it as `ownerUserId`.
            assigneeUserId: true,
        },
        orderBy: { dueDate: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.dueDate)
        .map((r): CalendarEvent => {
            const date = r.dueDate as Date;
            const isDone = r.status === 'CLOSED';
            return {
                id: `FINDING:${r.id}:finding-due`,
                type: 'finding-due',
                category: 'finding',
                title: `Finding due: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                status: classifyStatus(date, now, isDone),
                entityType: 'FINDING',
                entityId: r.id,
                // Findings have no `/findings/[id]` detail route — land on the
                // findings list rather than a 404.
                href: tenantHrefFromCtx(ctx, `/findings`),
                // `Finding.owner` is a legacy free-text NAME — the schema says
                // so in the comment directly above `assigneeUserId`, which
                // supersedes it. Publishing it as `ownerUserId` meant a value
                // that can never equal a cuid, so "My deadlines" matched no
                // finding for anyone, including its actual assignee.
                //
                // Deliberately no `?? r.owner` fallback: a NAME in this field
                // is strictly worse than absence. Absent, the digest routes the
                // item to tenant admins; a name resolves to no user and the
                // item is dropped as unroutable.
                ownerUserId: r.assigneeUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

