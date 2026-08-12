/**
 * Calendar loaders — asset-audit.
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

export async function loadAssetVulnerabilityEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.assetVulnerability.findMany({
        where: {
            tenantId: ctx.tenantId,
            remediationDueAt: { not: null, gte: range.from, lte: range.to },
            asset: { deletedAt: null },
        },
        select: {
            id: true,
            cveId: true,
            status: true,
            remediationDueAt: true,
            ownerUserId: true,
            assetId: true,
            asset: { select: { name: true } },
        },
        orderBy: { remediationDueAt: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.remediationDueAt)
        .map((r): CalendarEvent => {
            const date = r.remediationDueAt as Date;
            return {
                id: `ASSET_VULNERABILITY:${r.id}:vulnerability-remediation-due`,
                type: 'vulnerability-remediation-due',
                category: 'control',
                title: `Remediation due: ${r.cveId}`,
                entityName: r.cveId,
                detail: r.asset.name,
                date: date.toISOString(),
                // RESOLVED/ACCEPTED extinguish the remediation obligation the
                // date encodes — unlike a control's status, which does not.
                status: classifyStatus(
                    date,
                    now,
                    r.status === 'RESOLVED' || r.status === 'ACCEPTED',
                ),
                entityType: 'ASSET_VULNERABILITY',
                entityId: r.id,
                href: tenantHrefFromCtx(ctx, `/assets/${r.assetId}`),
                ownerUserId: r.ownerUserId ?? undefined,
            };
        });
    return sourceResult(events, rows.length, limit);
}

/**
 * Scheduled audit dates (`Audit.schedule`).
 *
 * Distinct from `audit-cycle`, which spans months — this is the day fieldwork
 * on one audit begins. The cycle being on the calendar made the omission easy
 * to miss: the surface looked like it covered audits already.
 */
export async function loadAuditEvents(
    db: PrismaTx,
    ctx: RequestContext,
    range: DateRange,
    now: Date,
    limit: number,
): Promise<CalendarSourceResult> {
    const rows = await db.audit.findMany({
        where: {
            tenantId: ctx.tenantId,
            deletedAt: null,
            schedule: { not: null, gte: range.from, lte: range.to },
        },
        select: {
            id: true,
            title: true,
            schedule: true,
            status: true,
        },
        orderBy: { schedule: 'asc' },
        take: limit,
    });
    const events = rows
        .filter((r) => r.schedule)
        .map((r): CalendarEvent => {
            const date = r.schedule as Date;
            return {
                id: `AUDIT:${r.id}:audit-scheduled`,
                type: 'audit-scheduled',
                category: 'audit',
                title: `Audit: ${r.title}`,
                entityName: r.title,
                date: date.toISOString(),
                // A completed audit has no scheduled start left to meet.
                status: classifyStatus(date, now, r.status === 'COMPLETED'),
                entityType: 'AUDIT',
                entityId: r.id,
                // The hub is a master-detail page with a ?selected= deep link;
                // there is no /audits/[id] route.
                href: tenantHrefFromCtx(ctx, `/audits?selected=${r.id}`),
            };
        });
    return sourceResult(events, rows.length, limit);
}

