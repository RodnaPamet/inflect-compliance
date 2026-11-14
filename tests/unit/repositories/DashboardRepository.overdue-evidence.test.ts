/**
 * `getStats().overdueEvidence` asks the question `getEvidenceExpiry().overdue`
 * asks (#5305).
 *
 * The assistant reads `getStats`; the dashboard's overdue tile reads
 * `getEvidenceExpiry`. `getStats` counted every evidence row past its review
 * date whatever its archive state, so a tenant that archived a batch of stale,
 * unapproved evidence saw 0 overdue on the dashboard and "N overdue for
 * re-review" from the assistant.
 *
 * Asserted as equality of the two WHEREs (bar the clock), so a later change to
 * the shared expiry scope cannot leave one of them behind.
 */
import { DashboardRepository } from '@/app-layer/repositories/DashboardRepository';
import type { PrismaTx } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

function recordingDb() {
    const evidenceCount = jest.fn().mockResolvedValue(0);
    const count = () => jest.fn().mockResolvedValue(0);
    const db = {
        risk: { count: count() },
        control: { count: count() },
        evidence: { count: evidenceCount },
        task: { count: count() },
        finding: { count: count() },
    } as unknown as PrismaTx;
    return { db, evidenceCount };
}

/** The evidence `where` whose date predicate is `nextReviewDate < now`. */
function overdueWhere(calls: unknown[][]): Record<string, unknown> {
    const hit = calls
        .map((c) => (c[0] as { where: Record<string, unknown> }).where)
        .find((w) => {
            const d = w.nextReviewDate as { lt?: unknown } | undefined;
            return d !== undefined && d !== null && 'lt' in d && !('gte' in d);
        });
    if (!hit) throw new Error('no overdue count was issued');
    const { nextReviewDate: _clock, ...rest } = hit;
    return rest;
}

describe('the overdue-evidence figure is one definition', () => {
    const ctx = makeRequestContext('ADMIN');

    it('getStats counts overdue evidence with the expiry scope getEvidenceExpiry uses', async () => {
        const stats = recordingDb();
        await DashboardRepository.getStats(stats.db, ctx);
        const expiry = recordingDb();
        await DashboardRepository.getEvidenceExpiry(expiry.db, ctx);

        const fromStats = overdueWhere(stats.evidenceCount.mock.calls);
        expect(fromStats).toEqual(overdueWhere(expiry.evidenceCount.mock.calls));
        // Named, so the reason it matters is in the failure: archived rows are out.
        expect(fromStats).toMatchObject({ tenantId: ctx.tenantId, isArchived: false, deletedAt: null });
    });
});
