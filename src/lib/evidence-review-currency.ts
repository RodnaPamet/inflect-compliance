/**
 * EP-2 — review-currency helpers for the Evidence library.
 *
 * The `<FreshnessBadge>` on the evidence list previously read
 * `updatedAt`, so any metadata edit or archive-toggle reset the age
 * and made an overdue document look fresh. These helpers drive
 * freshness from the *review schedule* instead:
 *
 *   - `reviewCurrencyAnchor` — the timestamp whose age the freshness
 *     badge should reflect: `nextReviewDate` (primary), falling back
 *     to `expiredAt` (retention expiry) when no review date is set.
 *     A future review date reads as "fresh" (clamped to age 0); a
 *     past one reads as increasingly stale — i.e. "overdue for
 *     review" tracks the schedule, not the last edit.
 *
 *   - `evidenceFreshnessBucket` — categorises a row into one of the
 *     four freshness buckets backing the freshness filter + KPI
 *     strip.
 *
 * Pure `.ts` so node-only unit tests can exercise the matrix without
 * React / jsdom.
 */

export interface ReviewCurrencyRow {
    status?: string | null;
    nextReviewDate?: string | Date | null;
    reviewCycle?: string | null;
    expiredAt?: string | Date | null;
    retentionUntil?: string | Date | null;
}

export type EvidenceFreshnessBucket =
    | 'current'
    | 'expiring'
    | 'expired'
    | 'needs_review';

/**
 * EP-4 — the tenant-wide evidence retention/KPI aggregate shape.
 *
 * Computed by `getEvidenceRetentionMetrics` over the FULL dataset (a DB
 * aggregate, not the ≤100-row SSR slice) so the Evidence list KPI strips
 * and the "all current" celebration reflect the whole tenant. Defined in
 * this pure `.ts` lib so both the server usecase/repository and the client
 * island share exactly one contract.
 *
 * Bucket semantics mirror `evidenceFreshnessBucket` over the ACTIVE bucket
 * (not deleted, not archived, no `expiredAt`) — the rows the list shows by
 * default, so a card counts what its click shows (#4277; archived and
 * expired evidence used to be counted too). `needsReview` wins outright
 * (status NEEDS_REVIEW); then `expired` (the review/retention date lapsed,
 * not yet swept); then `expiringSoon` (review/retention date within 30
 * days); `current` is the remainder. `archived` / `archivedView` describe
 * the rest of the library.
 */
export interface EvidenceRetentionMetrics {
    /** Active evidence — every status and freshness count below is of these. */
    total: number;
    byStatus: Record<
        'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW',
        number
    >;
    /** Not archived, not expired, not deleted — the live workspace. Equals `total`. */
    active: number;
    /** isArchived = true (not deleted). */
    archived: number;
    /** The Archived view's rows: archived OR expired (not deleted). */
    archivedView: number;
    /** Freshness "expiring" bucket count (review/retention date ≤ 30d out). */
    expiringSoon: number;
    /** Freshness "expired" bucket count (review/retention date lapsed, not yet swept). */
    expired: number;
    /** status = NEEDS_REVIEW. */
    needsReview: number;
    /** Freshness "current" bucket count (total − needsReview − expired − expiringSoon). */
    current: number;
}

const MS_PER_DAY = 86_400_000;
const EXPIRING_WINDOW_DAYS = 30;

function toDate(v: string | Date | null | undefined): Date | null {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The timestamp whose age the freshness badge should reflect.
 * `nextReviewDate` first, then `expiredAt`. When neither exists there
 * is no review schedule to be overdue against → `null` (the badge
 * renders its "no refresh recorded" state).
 */
export function reviewCurrencyAnchor(
    ev: ReviewCurrencyRow,
): string | Date | null {
    return ev.nextReviewDate ?? ev.expiredAt ?? null;
}

/**
 * Categorise a row's review-currency. `NEEDS_REVIEW` status wins
 * outright (the stale-review sweep already flagged it); then explicit
 * expiry; then the review-date / retention window.
 */
export function evidenceFreshnessBucket(
    ev: ReviewCurrencyRow,
    now?: Date | null,
): EvidenceFreshnessBucket {
    if (ev.status === 'NEEDS_REVIEW') return 'needs_review';
    const ref = now ?? new Date();
    const refMs = ref.getTime();

    if (toDate(ev.expiredAt)) return 'expired';

    const next = toDate(ev.nextReviewDate);
    if (next) {
        if (next.getTime() < refMs) return 'expired';
        if (next.getTime() <= refMs + EXPIRING_WINDOW_DAYS * MS_PER_DAY) {
            return 'expiring';
        }
        return 'current';
    }

    const retention = toDate(ev.retentionUntil);
    if (retention) {
        if (retention.getTime() < refMs) return 'expired';
        if (retention.getTime() <= refMs + EXPIRING_WINDOW_DAYS * MS_PER_DAY) {
            return 'expiring';
        }
    }

    return 'current';
}
