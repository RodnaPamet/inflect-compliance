/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Risks KPI cards read the SERVER count, not the loaded array.
 *
 * Risks was the last list surface still counting client-side, and it carried
 * both halves of the defect the peers (Policies #1905, Vendors #1917, Tests
 * #1918, Controls) were each fixed for:
 *
 *   `total` displayed the CURRENT FILTERED length while its click calls
 *   clearAll() — so with any filter set, the number and the click disagreed.
 *
 *   `open` counted inside a set that already had `status` applied, while its
 *   click REPLACES that dimension — so under any status filter it read 0.
 *
 * Both were windowed by the 5,000-row backfill cap on top of that.
 *
 * Behavioural, not structural: a mock `db` records the arguments each
 * aggregate receives, so these assertions fail if the WHERE shapes regress
 * even when the method still exists and still returns three numbers.
 */
import { RiskRepository } from '@/app-layer/repositories/RiskRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function freshDb(groups: Array<{ status: string; n: number }>, total: number, avg: number | null) {
    return {
        risk: {
            groupBy: jest.fn((..._a: any[]): Promise<any> =>
                Promise.resolve(groups.map((g) => ({ status: g.status, _count: { _all: g.n } })))),
            count: jest.fn((..._a: any[]): Promise<any> => Promise.resolve(total)),
            aggregate: jest.fn((..._a: any[]): Promise<any> =>
                Promise.resolve({ _avg: { inherentScore: avg } })),
        },
    } as any;
}

describe('RiskRepository.kpiCounts', () => {
    it('total counts the whole tenant, ignoring the active filters', async () => {
        // `total`'s click is clearAll(), so its number must not be narrowed by
        // whatever filter happens to be applied when it renders.
        const db = freshDb([], 412, 9);
        const counts = await RiskRepository.kpiCounts(db, ctx, { status: 'OPEN', q: 'ransom' });

        expect(counts.total).toBe(412);
        const where = db.risk.count.mock.calls[0][0].where;
        expect(where).toEqual({ tenantId: ctx.tenantId });
    });

    it('open groups over the other filters with status DROPPED', async () => {
        // This is the half that made the card read 0 permanently: counting
        // OPEN inside a set already filtered to MITIGATING yields nothing.
        const db = freshDb([{ status: 'OPEN', n: 7 }, { status: 'MITIGATING', n: 3 }], 40, 11);
        await RiskRepository.kpiCounts(db, ctx, { status: 'MITIGATING', category: 'Ops' });

        const arg = db.risk.groupBy.mock.calls[0][0];
        expect(arg.by).toEqual(['status']);
        // the sibling filter survives …
        expect(arg.where.category).toBe('Ops');
        // … and the status dimension the card replaces does not constrain it.
        expect(arg.where.status).toBeUndefined();
    });

    it('open sums BOTH statuses the card displays', async () => {
        // The card labels OPEN + MITIGATING under one heading and has always
        // shown their sum. Counting one would under-report the card's own
        // meaning — the Policies `approved` defect in a different costume.
        const db = freshDb(
            [{ status: 'OPEN', n: 7 }, { status: 'MITIGATING', n: 3 }, { status: 'CLOSED', n: 99 }],
            140,
            11,
        );
        const counts = await RiskRepository.kpiCounts(db, ctx);

        expect(counts.open).toBe(10);
    });

    it('avgScore is an aggregate over the current filters, not the page', async () => {
        // The one card that is NOT clickable, so it describes the current
        // view — but by aggregate, so it stays correct above the row cap.
        const db = freshDb([], 40, 12.5);
        const counts = await RiskRepository.kpiCounts(db, ctx, { category: 'Ops' });

        expect(counts.avgScore).toBe(12.5);
        const arg = db.risk.aggregate.mock.calls[0][0];
        expect(arg._avg).toEqual({ inherentScore: true });
        expect(arg.where.category).toBe('Ops');
    });

    it('an empty register averages 0 rather than null', async () => {
        // Prisma returns `_avg: { inherentScore: null }` for zero rows; the
        // card renders `.toFixed(1)` on this value.
        const db = freshDb([], 0, null);
        const counts = await RiskRepository.kpiCounts(db, ctx);

        expect(counts).toEqual({ total: 0, open: 0, avgScore: 0 });
    });
});
