/**
 * When a Business Impact Analysis is due for review. `listBias` applies it on
 * the server, once per register read, to the summary's count and to each
 * row's "Review overdue" badge, so the two agree and the page never compares
 * against the clock during render.
 */

/** A BIA reviewed longer ago than this, or never, is overdue. */
export const BIA_REVIEW_STALE_DAYS = 365;

export function isBiaReviewOverdue(reviewedAt: string | Date | null, now: number = Date.now()): boolean {
    if (!reviewedAt) return true;
    return now - new Date(reviewedAt).getTime() > BIA_REVIEW_STALE_DAYS * 86_400_000;
}
