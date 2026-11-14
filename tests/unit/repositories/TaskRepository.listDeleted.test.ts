/**
 * The Tasks Deleted view says when it is incomplete (#5303).
 *
 * `listDeleted` read exactly the cap and the route answered
 * `truncated: false` whatever came back, so a tenant with more deleted tasks
 * than the cap saw the most recent ones and nothing saying the list stopped —
 * an older task looked unrecoverable until the purge removed it. It now reads
 * one past the cap and reports what it found.
 */
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import { TASK_DELETED_LIST_CAP } from '@/lib/list-backfill-cap';
import { makeRequestContext } from '../../helpers/make-context';

function fakeDb(available: number) {
    const findMany = jest.fn(async (args: { take: number }) =>
        Array.from({ length: Math.min(available, args.take) }, (_, i) => ({ id: `t${i}`, links: [] })),
    );
    return { db: { task: { findMany }, control: { findMany: jest.fn(async () => []) } }, findMany };
}

const ctx = makeRequestContext('ADMIN');

describe('TaskRepository.listDeleted', () => {
    it('reports truncated when more deleted tasks exist than the cap, and returns the cap', async () => {
        const { db, findMany } = fakeDb(TASK_DELETED_LIST_CAP + 50);
        const result = await TaskRepository.listDeleted(db as never, ctx);
        expect(findMany.mock.calls[0][0].take).toBe(TASK_DELETED_LIST_CAP + 1);
        expect(result.truncated).toBe(true);
        expect(result.rows).toHaveLength(TASK_DELETED_LIST_CAP);
    });

    it('a set of exactly the cap is complete', async () => {
        const { db } = fakeDb(TASK_DELETED_LIST_CAP);
        const result = await TaskRepository.listDeleted(db as never, ctx);
        expect(result.truncated).toBe(false);
        expect(result.rows).toHaveLength(TASK_DELETED_LIST_CAP);
    });

    it('a small set is complete and whole', async () => {
        const { db } = fakeDb(3);
        const result = await TaskRepository.listDeleted(db as never, ctx);
        expect(result).toEqual({
            truncated: false,
            rows: [
                { id: 't0', linkedControls: [] },
                { id: 't1', linkedControls: [] },
                { id: 't2', linkedControls: [] },
            ],
        });
    });
});
