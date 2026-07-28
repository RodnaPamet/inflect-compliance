/**
 * Evidence expiry — the single definition of "what's expiring".
 *
 * Multiple surfaces answer that question and they used to answer it three
 * different ways, so the same evidence row could be red on one screen,
 * absent from another, and counted on a third:
 *
 *   - the compliance calendar's evidence loader (no soft-delete or
 *     archive guard at all → showed phantom reviews for deleted rows),
 *   - `DashboardRepository.getEvidenceExpiry` (the KPI buckets),
 *   - the dashboard's ExpiryCalendar list (since removed — its
 *     `getUpcomingExpirations` repo method went with it).
 *
 * Both halves of the definition live here so a future surface inherits
 * them rather than inventing a fourth variant:
 *
 *   1. SCOPE — which rows exist at all for expiry purposes. A
 *      soft-deleted or archived row is gone; showing a review deadline
 *      for it is a phantom.
 *   2. OUTSTANDING — which of those rows still owe someone work.
 *      APPROVED evidence has been reviewed; it no longer owes a review.
 *
 * Note `Evidence.expiredAt` is deliberately NOT part of this: it is
 * stamped at the moment of expiry by the retention job (`retention.ts`
 * sets `expiredAt = now`), so it is a past-tense receipt, not a
 * forward-looking deadline. `nextReviewDate` is the deadline.
 */
import type { Prisma } from '@prisma/client';

/**
 * The rows any expiry surface is allowed to consider: this tenant's,
 * not soft-deleted, not archived.
 *
 * Spread it into a `where` and add the date predicate the surface needs:
 *
 *   where: { ...evidenceExpiryScopeWhere(tenantId), nextReviewDate: {...} }
 */
export function evidenceExpiryScopeWhere(tenantId: string): Prisma.EvidenceWhereInput {
    return { tenantId, deletedAt: null, isArchived: false };
}

/**
 * An evidence review obligation is OUTSTANDING until the evidence is
 * APPROVED. Surfaces that list "what still needs attention" filter on
 * this; surfaces that classify a row (rather than filter it out) compare
 * against `EVIDENCE_REVIEWED_STATUS` instead.
 */
export const EVIDENCE_OUTSTANDING_STATUS_FILTER = {
    not: 'APPROVED',
} as const satisfies Prisma.EnumEvidenceStatusFilter;

/** The status that means "this review has been done". */
export const EVIDENCE_REVIEWED_STATUS = 'APPROVED' as const;
