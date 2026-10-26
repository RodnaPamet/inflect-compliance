/**
 * The Evidence KPI cards count ACTIVE evidence only (#4277, option A).
 *
 * The list shows the Active bucket by default (`tab=active`), and a status
 * card only sets `status` — so a card that counted archived and expired
 * evidence too could promise rows its own click could not show ("Total" and
 * "Draft" exceeding the list). Every status and freshness count, and the
 * "all current" celebration that reads them, is now over the Active bucket:
 * `evidenceRetentionTabWhere('active')`, the predicate the list itself uses.
 * `archivedView` counts the Archived bucket, so the empty state can still
 * tell "nothing active" from "nothing at all".
 *
 * Asserted on the queries handed to Prisma (fake `db`), as the repository's
 * other where-shape tests are; the counts against a real DB are in
 * tests/integration/evidence-retention-metrics.test.ts.
 */
import { EvidenceRepository, evidenceRetentionTabWhere } from '@/app-layer/repositories/EvidenceRepository';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');
const ACTIVE = evidenceRetentionTabWhere('active', new Date());
const ARCHIVED = evidenceRetentionTabWhere('archived', new Date());

type Where = Record<string, unknown>;

function fakeDb(counts: number[]) {
    const groupBy = jest.fn().mockResolvedValue([
        { status: 'DRAFT', _count: 4 },
        { status: 'APPROVED', _count: 2 },
    ]);
    const count = jest.fn();
    for (const c of counts) count.mockResolvedValueOnce(c);
    return { db: { evidence: { groupBy, count } } as unknown as PrismaTx, groupBy, count };
}

/** Does `where` require the active bucket (directly or inside an AND)? */
function requiresActive(where: Where): boolean {
    const and = (where.AND as Where[] | undefined) ?? [];
    return and.some((w) => JSON.stringify(w) === JSON.stringify(ACTIVE));
}

describe('evidence retention metrics — the KPI cards count active evidence', () => {
    it('the status counts are over the active bucket', async () => {
        const { db, groupBy } = fakeDb([1, 3, 0, 0]);
        await EvidenceRepository.retentionMetrics(db, ctx);
        expect(requiresActive(groupBy.mock.calls[0][0].where)).toBe(true);
    });

    it('the expired and expiring-soon counts are over the active bucket', async () => {
        const { db, count } = fakeDb([1, 3, 0, 0]);
        await EvidenceRepository.retentionMetrics(db, ctx);
        // count #3 = expired, #4 = expiring soon (the order in the source).
        expect(requiresActive(count.mock.calls[2][0].where)).toBe(true);
        expect(requiresActive(count.mock.calls[3][0].where)).toBe(true);
    });

    it('total and every freshness bucket add up to the active rows', async () => {
        // archived=1, archivedView=3, expired=1, expiringSoon=2
        const { db } = fakeDb([1, 3, 1, 2]);
        const m = await EvidenceRepository.retentionMetrics(db, ctx);
        expect(m.total).toBe(6);
        expect(m.active).toBe(6);
        expect(m.current + m.expired + m.expiringSoon + m.needsReview).toBe(m.total);
    });

    it('archivedView counts the Archived bucket, for the empty state', async () => {
        const { db, count } = fakeDb([1, 3, 0, 0]);
        const m = await EvidenceRepository.retentionMetrics(db, ctx);
        const where = count.mock.calls[1][0].where as Where;
        expect((where.AND as Where[]).some((w) => JSON.stringify(w) === JSON.stringify(ARCHIVED))).toBe(true);
        expect(m.archivedView).toBe(3);
    });
});
