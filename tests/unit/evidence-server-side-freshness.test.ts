/**
 * Freshness and the retention tab are SERVER-side predicates.
 *
 * Both used to be applied in the client, over whatever rows the backfill cap
 * returned. `freshness` was the starker case: the UI sent the param and the
 * route's schema `.strip()`ped it, so the filter silently never reached the
 * database and the page instead filtered one loaded page a second time. That is
 * why it carried a `freshnessCountMismatch` banner — the KPI tiles counted the
 * whole tenant while the filter counted a page, so the two disagreed by
 * construction and the page had to explain itself to the user.
 *
 * These assert the PREDICATES rather than generated SQL, for the same reason as
 * the expiring-soon tests: the defect was two definitions of one thing, so what
 * needs locking is that each bucket means exactly what the badge means.
 */
import {
    evidenceFreshnessWhere,
    evidenceExpiredWhere,
    evidenceExpiringSoonWhere,
    evidenceRetentionTabWhere,
} from '@/app-layer/repositories/EvidenceRepository';

const NOW = new Date('2026-08-14T12:00:00.000Z');

describe('evidenceFreshnessWhere — the badge buckets, as SQL', () => {
    it('needs_review is status-only, matching the badge precedence', () => {
        // `evidenceFreshnessBucket` returns needs_review BEFORE looking at any
        // date, so the predicate must not add date conditions.
        expect(evidenceFreshnessWhere('needs_review', NOW)).toEqual({
            status: 'NEEDS_REVIEW',
        });
    });

    it('expired follows expiredAt → nextReviewDate → retentionUntil', () => {
        const w = evidenceExpiredWhere(NOW);
        const branches = w.OR as Array<Record<string, unknown>>;

        expect(w.status).toEqual({ not: 'NEEDS_REVIEW' });
        expect(branches).toHaveLength(3);
        // The fallbacks are guarded so a row cannot match on a later branch
        // when an earlier field is set — that is what "precedence" means here.
        expect(branches[1]).toMatchObject({ expiredAt: null });
        expect(branches[2]).toMatchObject({ expiredAt: null, nextReviewDate: null });
    });

    it('expiring reuses the ONE shared definition', () => {
        // Not a second copy: the same predicate the KPI tile and the retention
        // tab use. A separate implementation here is how they drifted before.
        expect(evidenceFreshnessWhere('expiring', NOW)).toEqual(
            evidenceExpiringSoonWhere(NOW),
        );
    });

    it('current is the negation of the other three, not a fourth definition', () => {
        // Restating "current" positively is how a row ends up in two buckets or
        // none when one of the others changes.
        const w = evidenceFreshnessWhere('current', NOW)!;
        expect(w.NOT).toEqual([
            { status: 'NEEDS_REVIEW' },
            evidenceExpiredWhere(NOW),
            evidenceExpiringSoonWhere(NOW),
        ]);
    });

    it('an unrecognised bucket applies NO filter rather than matching nothing', () => {
        // A stale URL must not silently render an empty table.
        expect(evidenceFreshnessWhere('nonsense', NOW)).toBeUndefined();
    });
});

describe('evidenceRetentionTabWhere', () => {
    it('active excludes archived and lapsed rows', () => {
        expect(evidenceRetentionTabWhere('active', NOW)).toEqual({
            isArchived: false,
            expiredAt: null,
        });
    });

    it('expiring adopts the unified definition, not the old retention-only one', () => {
        // Deliberate behaviour change. The client partitioned this tab on
        // `retentionUntil` alone; the tile had already moved to preferring
        // `nextReviewDate`. Sharing the predicate is what makes the tab and the
        // tile agree.
        expect(evidenceRetentionTabWhere('expiring', NOW)).toEqual(
            evidenceExpiringSoonWhere(NOW),
        );
    });

    it('archived covers the flag OR a lapsed row, as the client did', () => {
        expect(evidenceRetentionTabWhere('archived', NOW)).toEqual({
            OR: [{ isArchived: true }, { expiredAt: { not: null } }],
        });
    });

    it('an unrecognised tab applies no filter', () => {
        expect(evidenceRetentionTabWhere('', NOW)).toBeUndefined();
    });
});
