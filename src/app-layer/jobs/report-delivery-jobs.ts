/**
 * RQ-10 — scheduled report delivery cron (cross-tenant fan-out).
 *
 * Finds due ReportSchedules, generates the report, EMAILS the artefact to the
 * recipients as an attachment, and advances nextRunAt. (SharePoint push to
 * `sharePointFolderId` awaits a Graph upload primitive — see the impl note.)
 *
 * @module jobs/report-delivery-jobs
 */
import prisma from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { generateReport, deliverReportByEmail, deliverReportToSharePoint, computeNextRun, type ReportFormat } from '@/app-layer/usecases/risk-report';
import { logger } from '@/lib/observability/logger';
import type { ReportDeliveryPayload } from './types';

const asRecipients = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The principal this cron acts as.
 *
 * Not a real user, deliberately. `requestedBy` and the audit trail need to say
 * "the scheduler ran this" — attributing an automated delivery to a person who
 * did not press anything is worse than saying nothing.
 */
export const REPORT_DELIVERY_PRINCIPAL = 'system:report-delivery';

/**
 * Synthetic execution context for one tenant's scheduled delivery.
 *
 * ── What this replaces, and why ─────────────────────────────────────
 *
 * This used to look up the tenant's OLDEST ACTIVE OWNER/ADMIN and execute the
 * schedule as that person. Three things were wrong with it:
 *
 *   1. **Borrowed authority.** An EDITOR could create a schedule and it would
 *      run with owner privileges — a privilege escalation with a weekly cadence.
 *   2. **False attribution.** `generateReport` stamps `ReportRun.requestedBy`
 *      with `ctx.userId`, so the audit trail recorded that owner as having
 *      requested an export they had never heard of.
 *   3. **Starvation.** When a tenant had NO active owner or admin, `buildCtx`
 *      returned null, the loop `continue`d before advancing `nextRunAt`, and
 *      every one of that tenant's schedules stayed `lte: now` — re-selected in
 *      the take:1000 window on every daily run, forever, crowding out real work.
 *
 * A fixed synthetic principal fixes all three at once: no identity is borrowed,
 * the run records the SCHEDULE'S AUTHOR in `requestedBy`, and no tenant can fail
 * to produce a context, so the null branch that caused the starvation is gone.
 *
 * Permissions are stated explicitly rather than derived from a role. The cron
 * needs exactly two things — read the risk surfaces, write a ReportRun — and
 * granting it a role's full sheet would re-create the borrowed-authority problem
 * in a new shape.
 */
function buildSystemCtx(tenantId: string): RequestContext {
    const appPermissions = getPermissionsForRole('ADMIN');
    return {
        requestId: `report-delivery-${tenantId}`,
        userId: REPORT_DELIVERY_PRINCIPAL,
        // Machine actor. This job does NOT go through `buildSystemContext`:
        // it already has a synthetic principal AND a deliberately narrowed
        // `appPermissions` (below), so routing it through the shared builder
        // would WIDEN it back to plain ADMIN. It was the best-behaved of the
        // thirteen fabricated contexts; all it lacked was saying so.
        actorType: 'JOB',
        tenantId,
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: false,
            canAudit: false,
            canExport: true,
        },
        appPermissions: {
            ...appPermissions,
            // The cron must never be a path to admin actions, and it must not be
            // able to widen a schedule's own destination — the recipient list it
            // delivers to was validated when a human saved it.
            admin: { ...appPermissions.admin, manage: false, tenant_lifecycle: false, owner_management: false },
            reports: { ...appPermissions.reports, schedule_external: false },
        },
    };
}

export async function runReportDelivery(_payload: ReportDeliveryPayload) {
    const now = new Date();
    const due = await prisma.reportSchedule.findMany({
        where: { isActive: true, nextRunAt: { lte: now } },
        // Most-overdue first. There was no ordering at all, so which 1000 of a
        // larger backlog got picked was whatever the planner returned — and any
        // schedule outside that arbitrary window could be skipped repeatedly
        // while newer ones ran. Oldest-first makes the take a fair queue rather
        // than a lottery.
        orderBy: { nextRunAt: 'asc' },
        select: { id: true, tenantId: true, templateId: true, format: true, cadence: true, parametersJson: true, recipientsJson: true, sharePointDriveId: true, sharePointFolderId: true, createdByUserId: true, template: { select: { name: true } } },
        take: 1000,
    });
    let generated = 0, delivered = 0, pushed = 0, failed = 0;
    for (const s of due) {
        const ctx = buildSystemCtx(s.tenantId);
        try {
            const run = await generateReport(
                ctx,
                s.templateId,
                (s.parametersJson ?? {}) as Record<string, unknown>,
                (s.format as ReportFormat) ?? 'PDF',
                // Attribute the run to whoever set the schedule up, not to the
                // synthetic principal and certainly not to a borrowed admin.
                { requestedBy: s.createdByUserId ?? null },
            );
            generated++;
            const label = s.template?.name ?? 'Risk report';
            const sent = await deliverReportByEmail(ctx, run, asRecipients(s.recipientsJson), label);
            if (sent > 0) delivered++;
            const spItemId = await deliverReportToSharePoint(ctx, run, s.sharePointDriveId, s.sharePointFolderId, label);
            if (spItemId) pushed++;
            logger.info('report-delivery: generated + delivered scheduled report', {
                component: 'report-delivery', tenantId: s.tenantId, scheduleId: s.id, runId: run.id,
                recipients: sent, sharePoint: spItemId ? 'pushed' : 'skipped',
            });
        } catch (err) {
            failed++;
            logger.warn('report-delivery: scheduled generation failed', {
                component: 'report-delivery', tenantId: s.tenantId, scheduleId: s.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        await prisma.reportSchedule.update({
            where: { id: s.id },
            data: { lastRunAt: now, nextRunAt: computeNextRun(s.cadence, now) },
        });
    }
    return { due: due.length, generated, delivered, pushed, failed };
}
