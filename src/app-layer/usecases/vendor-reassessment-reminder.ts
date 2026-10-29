/**
 * Vendor re-assessment reminder — Audit Coherence S6 (2026-05-22).
 *
 * Auditors expect vendor due-diligence to follow a cadence: a vendor
 * marked for review by `nextReviewAt` gets re-assessed or has its date
 * deliberately extended. Pre-this-cron the `compliance-calendar` view
 * surfaced overdue vendors but no automated reminder fired — operators
 * only saw them by clicking into the calendar tab.
 *
 * This sweep finds every non-deleted, non-offboarded vendor whose
 * `nextReviewAt` is in the past and sends the vendor's OWNER an in-app
 * `VENDOR_REVIEW_DUE` notification. A vendor with no owner gets no
 * in-app reminder from this sweep, and nobody else is notified in its
 * place. Its overdue review does reach the tenant's owners and admins by
 * email, through the 07:00 vendor-renewal digest, which routes unowned
 * items to them (`dispatchDigest`) unless the tenant has turned
 * notifications off.
 *
 * IT DOES NOT MOVE `nextReviewAt` (#4462). It used to set it to
 * now + 365 days for every overdue vendor, with no audit row, so the
 * "Review overdue" KPI, the Overdue badge and the 07:00 digest — all of
 * which read `nextReviewAt < now`, after this 02:00 run — saw an overdue
 * vendor for at most a day, and the review date silently changed. A
 * vendor now stays overdue until a review is done. What moves the date:
 *
 *   - a completed assessment review — `applyAssessmentRiskWriteback` in
 *     `vendor-assessment-review.ts` rolls it to now + 365 days when it is
 *     due or unset (and leaves a future, manually set date alone);
 *   - a person editing the review date on the vendor.
 *
 * The reminder fires ONCE per (vendor, owner, overdue date), not every
 * night: the notification's `dedupeKey` names the date it is about, so a
 * re-run — tonight's, or tomorrow's while the vendor is still overdue —
 * hits the unique index and writes nothing. A new owner, or a new date
 * that passes in turn, is a new reminder. Before the change above the
 * bump was what kept this from repeating; the key does it now.
 *
 * Tenant scoping: optional `tenantId` for single-tenant; absent
 * means sweep all (the cron uses absent; admin-triggered debug
 * uses set).
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runJob } from '@/lib/observability/job-runner';
import { tenantPageLink } from '@/app-layer/notifications/tenant-link';

export interface VendorReassessmentReminderOptions {
    /** Override "now" timestamp for tests. */
    now?: Date;
    /** Scope to one tenant. Absent = sweep all. */
    tenantId?: string;
}

export interface VendorReassessmentReminderResult {
    /** Reminders this sweep wrote — overdue vendors whose owner had not yet been reminded about that date. */
    reminded: number;
}

/**
 * The reminder's idempotency key: one per (vendor, owner, overdue date).
 * The date is the vendor's `nextReviewAt` day, not today's, so the same
 * overdue date is reminded about once however many nights it stays overdue.
 */
export function vendorReviewDueDedupeKey(
    tenantId: string,
    vendorId: string,
    ownerUserId: string,
    nextReviewAt: Date,
): string {
    return `${tenantId}:VENDOR_REVIEW_DUE:${vendorId}:${ownerUserId}:${nextReviewAt.toISOString().slice(0, 10)}`;
}

export async function runVendorReassessmentReminder(
    options: VendorReassessmentReminderOptions = {},
): Promise<VendorReassessmentReminderResult> {
    return runJob('vendor-reassessment-reminder', async () => {
        const now = options.now ?? new Date();

        // 1. Find past-due vendors with an owner to remind. (Vendor has
        // soft-delete via `deletedAt` but no `isArchived` column — vendors
        // are retired by setting `status = OFFBOARDED`, which we exclude
        // here so dormant relationships don't generate reminders.)
        const overdue = await prisma.vendor.findMany({
            where: {
                ...(options.tenantId ? { tenantId: options.tenantId } : {}),
                deletedAt: null,
                status: { not: 'OFFBOARDED' },
                nextReviewAt: { not: null, lt: now },
                ownerUserId: { not: null },
            },
            select: {
                id: true,
                tenantId: true,
                name: true,
                ownerUserId: true,
                nextReviewAt: true,
                // For the notification link — a tenant page lives under
                // `/t/<slug>/…`; the bare `/vendors/<id>` this used to store
                // 404'd from the bell (#4128). Joined, as `task-due` does.
                tenant: { select: { slug: true } },
            },
        });

        if (overdue.length === 0) {
            logger.info('vendor-reassessment-reminder: no overdue vendors with an owner', {
                component: 'job',
                tenantId: options.tenantId,
            });
            return { reminded: 0 };
        }

        // 2. Per-vendor: remind the owner, once per overdue date. Done
        // one-at-a-time so a single vendor's failure (e.g. owner row deleted
        // mid-cycle) doesn't sink the whole sweep.
        let reminded = 0;
        for (const v of overdue) {
            if (!v.ownerUserId || !v.nextReviewAt) continue;
            try {
                const res = await prisma.notification.createMany({
                    data: [{
                        tenantId: v.tenantId,
                        userId: v.ownerUserId,
                        type: 'VENDOR_REVIEW_DUE',
                        title: `Vendor review due: ${v.name}`,
                        message:
                            `Vendor "${v.name}" is past its scheduled review date. ` +
                            'Re-assess the vendor or extend the review date.',
                        linkUrl: tenantPageLink(v.tenant?.slug, `/vendors/${v.id}`),
                        dedupeKey: vendorReviewDueDedupeKey(v.tenantId, v.id, v.ownerUserId, v.nextReviewAt),
                    }],
                    // Already reminded about this date → the key exists → no row.
                    skipDuplicates: true,
                });
                reminded += res.count;
            } catch (err) {
                // Best-effort per vendor — don't fail the whole sweep
                // if one row's notification can't be written.
                logger.warn(
                    'vendor-reassessment-reminder: per-vendor write failed',
                    {
                        component: 'job',
                        vendorId: v.id,
                        tenantId: v.tenantId,
                        err: err instanceof Error ? err : new Error(String(err)),
                    },
                );
            }
        }

        logger.info('vendor-reassessment-reminder: sweep complete', {
            component: 'job',
            reminded,
            overdueFound: overdue.length,
            tenantId: options.tenantId,
        });
        return { reminded };
    }, { tenantId: options.tenantId });
}
