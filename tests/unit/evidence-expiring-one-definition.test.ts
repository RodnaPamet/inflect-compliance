/**
 * "Expiring soon" means ONE thing for evidence.
 *
 * The KPI tile and the list filter behind it computed it differently in three
 * ways at once, so the tile's number could not be reconciled with the rows the
 * tab showed:
 *
 *   tile   preferred `nextReviewDate`, fell back to `retentionUntil`,
 *          bounded the window at BOTH ends, and excluded NEEDS_REVIEW +
 *          already-expired rows to keep the freshness buckets exclusive.
 *   filter looked ONLY at `retentionUntil`, with `lte: soon` and NO lower
 *          bound — so every already-expired row counted as "expiring soon" —
 *          and excluded neither NEEDS_REVIEW nor expired.
 *
 * These test the shared predicate directly rather than the SQL it produces:
 * the defect was two definitions, so what needs locking is that there is now
 * one and that it says what the tile always meant.
 */
import {
    evidenceExpiringSoonWhere,
    EVIDENCE_EXPIRING_SOON_DAYS,
} from '@/app-layer/repositories/EvidenceRepository';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const soonMs = EVIDENCE_EXPIRING_SOON_DAYS * 86_400_000;

describe('evidenceExpiringSoonWhere — the one definition', () => {
    const w = evidenceExpiringSoonWhere(NOW);

    it('excludes already-expired rows', () => {
        // The old filter had no lower bound, so anything past its retention
        // date was reported as "expiring soon" — the largest single source of
        // disagreement with the tile.
        expect(w.expiredAt).toBeNull();
    });

    it('excludes NEEDS_REVIEW, which owns its own freshness bucket', () => {
        expect(w.status).toEqual({ not: 'NEEDS_REVIEW' });
    });

    it('prefers nextReviewDate and falls back to retentionUntil', () => {
        const branches = w.OR as Array<Record<string, unknown>>;
        expect(branches).toHaveLength(2);

        // Branch 1: a review date inside the window.
        expect(branches[0].nextReviewDate).toEqual({
            not: null,
            gte: NOW,
            lte: new Date(NOW.getTime() + soonMs),
        });

        // Branch 2: ONLY when there is no review date at all. Without this
        // guard a row with a far-future review date but a near retention date
        // would count, which is what the retention-only filter did.
        expect(branches[1].nextReviewDate).toBeNull();
        expect(branches[1].retentionUntil).toEqual({
            not: null,
            gte: NOW,
            lte: new Date(NOW.getTime() + soonMs),
        });
    });

    it('bounds the window at BOTH ends', () => {
        for (const branch of w.OR as Array<Record<string, unknown>>) {
            const range = (branch.nextReviewDate ?? branch.retentionUntil) as {
                gte?: Date;
                lte?: Date;
            };
            expect(range.gte).toEqual(NOW);
            expect(range.lte).toEqual(new Date(NOW.getTime() + soonMs));
        }
    });

    it('derives the window from the shared constant, not a literal', () => {
        // A second `30` written out somewhere is how the two definitions drifted
        // in the first place.
        expect(EVIDENCE_EXPIRING_SOON_DAYS).toBe(30);
        const other = evidenceExpiringSoonWhere(new Date('2027-01-01T00:00:00.000Z'));
        const b = (other.OR as Array<Record<string, unknown>>)[0].nextReviewDate as {
            gte: Date;
            lte: Date;
        };
        expect(b.lte.getTime() - b.gte.getTime()).toBe(soonMs);
    });
});
