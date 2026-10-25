/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * What the Policies list query asks the database for (#4279).
 *
 * Behavioural at the repository boundary: a fake `db` records the arguments
 * each Prisma call receives, so these fail if the shapes regress even when the
 * methods still exist and still return rows.
 */
import { PolicyRepository } from '@/app-layer/repositories/PolicyRepository';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function fakeDb() {
    return {
        policy: {
            findMany: jest.fn((..._a: any[]): Promise<any> => Promise.resolve([])),
            groupBy: jest.fn((..._a: any[]): Promise<any> => Promise.resolve([])),
            count: jest.fn((..._a: any[]): Promise<any> => Promise.resolve(0)),
        },
        $queryRaw: jest.fn((..._a: any[]): Promise<any> => Promise.resolve([])),
    } as any;
}

describe('PolicyRepository.list — the row shape', () => {
    it('carries the NEWEST version number, not only the published pointer', async () => {
        // `currentVersion` does not move when a draft is added and is null for
        // a policy created blank, so without this the Version column read "v1"
        // for every never-published policy.
        const db = fakeDb();
        await PolicyRepository.list(db, ctx);
        const select = db.policy.findMany.mock.calls[0][0].select;
        expect(select.versions).toEqual({
            select: { versionNumber: true },
            orderBy: { versionNumber: 'desc' },
            take: 1,
        });
        expect(select.currentVersion).toEqual({ select: { id: true, versionNumber: true } });
    });
});

describe('PolicyRepository.list — the Category filter', () => {
    it('two categories (the facet comma-joins them) match either, not the joined string', async () => {
        const db = fakeDb();
        await PolicyRepository.list(db, ctx, { category: 'HR,Compliance' });
        expect(db.policy.findMany.mock.calls[0][0].where.category).toEqual({ in: ['HR', 'Compliance'] });
    });

    it('one category stays an equality match', async () => {
        const db = fakeDb();
        await PolicyRepository.list(db, ctx, { category: 'Information Security' });
        expect(db.policy.findMany.mock.calls[0][0].where.category).toBe('Information Security');
    });

    it('the KPI counts honour two categories the same way', async () => {
        const db = fakeDb();
        await PolicyRepository.kpiCounts(db, ctx, { category: 'HR,Compliance' });
        expect(db.policy.groupBy.mock.calls[0][0].where.category).toEqual({ in: ['HR', 'Compliance'] });
    });
});

describe('PolicyRepository.distinctCategories — the facet options', () => {
    it('reads every category in the tenant, independent of any filter', async () => {
        const db = fakeDb();
        db.policy.groupBy.mockResolvedValue([{ category: 'Compliance' }, { category: ' HR ' }, { category: '  ' }]);
        expect(await PolicyRepository.distinctCategories(db, ctx)).toEqual(['Compliance', 'HR']);
        const arg = db.policy.groupBy.mock.calls[0][0];
        expect(arg.by).toEqual(['category']);
        expect(arg.where).toEqual({ tenantId: ctx.tenantId, category: { not: null } });
    });
});

describe('PolicyRepository.kpiCounts — each number predicts its own click', () => {
    // A card's click clears every OTHER card's key first (useKpiFilter), so a
    // count that kept them described a set the click never shows: with
    // "Due within 30 days" set, the Draft card counted drafts due within 30
    // days while its click showed every draft.
    const ACTIVE = { status: 'DRAFT', reviewBucket: 'upcoming' as const, outstandingAck: true, category: 'HR', q: 'access' };

    function whereOf(db: any) {
        const [overdueCall, ackCall] = [db.policy.count.mock.calls[1][0], db.policy.count.mock.calls[2][0]];
        return { status: db.policy.groupBy.mock.calls[0][0].where, overdue: overdueCall.where, ack: ackCall.where };
    }

    it('the status cards count over the card-free set: no review bucket, no acknowledgement narrowing', async () => {
        const db = fakeDb();
        await PolicyRepository.kpiCounts(db, ctx, ACTIVE);
        const { status } = whereOf(db);
        expect(status.status).toBeUndefined();
        expect(status.nextReviewAt).toBeUndefined();
        expect(status.currentVersionId).toBeUndefined();
        // Filters no card owns survive.
        expect(status.category).toBe('HR');
        expect(status.OR).toBeDefined();
    });

    it('Overdue review counts overdue policies with the status and acknowledgement keys cleared', async () => {
        const db = fakeDb();
        await PolicyRepository.kpiCounts(db, ctx, ACTIVE);
        const { overdue } = whereOf(db);
        expect(overdue.nextReviewAt).toEqual({ lt: expect.any(Date) });
        expect(overdue.status).toBeUndefined();
        expect(overdue.currentVersionId).toBeUndefined();
        expect(overdue.category).toBe('HR');
    });

    it('Outstanding acknowledgements counts with the status and review-bucket keys cleared', async () => {
        const db = fakeDb();
        db.$queryRaw.mockResolvedValue([{ policyVersionId: 'v1' }]);
        await PolicyRepository.kpiCounts(db, ctx, ACTIVE);
        const { ack } = whereOf(db);
        expect(ack.currentVersionId).toEqual({ in: ['v1'] });
        expect(ack.status).toBeUndefined();
        expect(ack.nextReviewAt).toBeUndefined();
        expect(ack.category).toBe('HR');
    });

    it('Total stays the whole tenant', async () => {
        const db = fakeDb();
        await PolicyRepository.kpiCounts(db, ctx, ACTIVE);
        expect(db.policy.count.mock.calls[0][0].where).toEqual({ tenantId: ctx.tenantId });
    });
});
