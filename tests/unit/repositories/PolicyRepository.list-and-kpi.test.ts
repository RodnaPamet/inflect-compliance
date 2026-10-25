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
