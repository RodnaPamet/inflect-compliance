/**
 * Coverage wave E — `src/lib/evidence-review-currency.ts`.
 *
 * The module is pure, so the whole freshness matrix is exercised
 * directly: anchor selection (nextReviewDate → expiredAt → null) and
 * every bucket branch, including the invalid-date path through the
 * internal `toDate` helper.
 *
 * `now` is always passed explicitly — the module accepts an injected
 * reference date precisely so these assertions never depend on wall
 * clock.
 */
import {
    reviewCurrencyAnchor,
    evidenceFreshnessBucket,
    type ReviewCurrencyRow,
} from '@/lib/evidence-review-currency';

const NOW = new Date('2026-07-01T00:00:00.000Z');
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

describe('reviewCurrencyAnchor', () => {
    it('prefers nextReviewDate when present', () => {
        const next = at(10);
        expect(
            reviewCurrencyAnchor({ nextReviewDate: next, expiredAt: at(-5) }),
        ).toBe(next);
    });

    it('falls back to expiredAt when there is no review date', () => {
        const expired = at(-5);
        expect(reviewCurrencyAnchor({ expiredAt: expired })).toBe(expired);
    });

    it('returns null when neither is set — no schedule to be overdue against', () => {
        expect(reviewCurrencyAnchor({})).toBeNull();
        expect(
            reviewCurrencyAnchor({ nextReviewDate: null, expiredAt: null }),
        ).toBeNull();
    });

    it('treats an explicit null nextReviewDate as absent, not as a value', () => {
        const expired = at(-1);
        expect(
            reviewCurrencyAnchor({ nextReviewDate: null, expiredAt: expired }),
        ).toBe(expired);
    });
});

describe('evidenceFreshnessBucket', () => {
    it('NEEDS_REVIEW status wins outright, even with a far-future review date', () => {
        const row: ReviewCurrencyRow = {
            status: 'NEEDS_REVIEW',
            nextReviewDate: at(365),
        };
        expect(evidenceFreshnessBucket(row, NOW)).toBe('needs_review');
    });

    it('an explicit expiredAt outranks a future review date', () => {
        const row: ReviewCurrencyRow = {
            expiredAt: at(-30),
            nextReviewDate: at(365),
        };
        expect(evidenceFreshnessBucket(row, NOW)).toBe('expired');
    });

    it('classifies a lapsed review date as expired', () => {
        expect(
            evidenceFreshnessBucket({ nextReviewDate: at(-1) }, NOW),
        ).toBe('expired');
    });

    it('classifies a review date inside the 30-day window as expiring', () => {
        expect(evidenceFreshnessBucket({ nextReviewDate: at(1) }, NOW)).toBe(
            'expiring',
        );
        // Boundary: exactly 30 days out is still "expiring" (<=).
        expect(evidenceFreshnessBucket({ nextReviewDate: at(30) }, NOW)).toBe(
            'expiring',
        );
    });

    it('classifies a review date beyond the window as current', () => {
        expect(evidenceFreshnessBucket({ nextReviewDate: at(31) }, NOW)).toBe(
            'current',
        );
    });

    it('falls through to retentionUntil when no review date is set', () => {
        expect(
            evidenceFreshnessBucket({ retentionUntil: at(-1) }, NOW),
        ).toBe('expired');
        expect(evidenceFreshnessBucket({ retentionUntil: at(5) }, NOW)).toBe(
            'expiring',
        );
        // Beyond the window, retention does not downgrade the row.
        expect(evidenceFreshnessBucket({ retentionUntil: at(90) }, NOW)).toBe(
            'current',
        );
    });

    it('is current when no dates are set at all', () => {
        expect(evidenceFreshnessBucket({}, NOW)).toBe('current');
    });

    it('accepts ISO strings as well as Date objects', () => {
        expect(
            evidenceFreshnessBucket(
                { nextReviewDate: at(-1).toISOString() },
                NOW,
            ),
        ).toBe('expired');
        expect(
            evidenceFreshnessBucket(
                { retentionUntil: at(5).toISOString() },
                NOW,
            ),
        ).toBe('expiring');
    });

    it('ignores unparseable dates rather than throwing', () => {
        // toDate() returns null for NaN timestamps, so the row falls
        // through to the next rule instead of being mis-bucketed.
        expect(
            evidenceFreshnessBucket({ nextReviewDate: 'not-a-date' }, NOW),
        ).toBe('current');
        expect(
            evidenceFreshnessBucket({ expiredAt: 'not-a-date' }, NOW),
        ).toBe('current');
        expect(
            evidenceFreshnessBucket({ retentionUntil: 'not-a-date' }, NOW),
        ).toBe('current');
    });

    it('defaults `now` to the wall clock when omitted', () => {
        // A review date far in the past is expired under any real clock.
        expect(
            evidenceFreshnessBucket({ nextReviewDate: '1999-01-01T00:00:00Z' }),
        ).toBe('expired');
        // …and far in the future is current under any real clock.
        expect(
            evidenceFreshnessBucket({ nextReviewDate: '2999-01-01T00:00:00Z' }),
        ).toBe('current');
    });

    it('treats a null `now` the same as omitting it', () => {
        expect(
            evidenceFreshnessBucket(
                { nextReviewDate: '1999-01-01T00:00:00Z' },
                null,
            ),
        ).toBe('expired');
    });
});
